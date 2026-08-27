/**
 * GLM Adapter
 * Implements GLM (Zhipu Qingyan) web API protocol
 */

import axios, { AxiosResponse } from 'axios'
import crypto from 'crypto'
import { Account, Provider } from '../../store/types'
import { storeManager } from '../../store/store'
import { PassThrough } from 'stream'
import {
  GLMRequestValidationError,
  resolveGLMChatMode,
  type GLMChatMode,
} from './providerModelOptions'
import { createParser } from 'eventsource-parser'
import FormData from 'form-data'
import mime from 'mime-types'
import path from 'path'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { 
  createBaseChunk,
} from '../utils/streamToolHandler'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import type { ToolCallingPlan } from '../toolCalling/types'
import {
  getAbortReason,
  RequestTimeoutError,
  throwIfAborted,
} from '../requestLifecycle'

const GLM_API_BASE = 'https://chatglm.cn/chatglm'
const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796'
const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb'
const ACCESS_TOKEN_EXPIRES = 3600
const FILE_MAX_SIZE = 100 * 1024 * 1024 // 100MB

const FAKE_HEADERS = {
  Accept: 'text/event-stream',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  'App-Name': 'chatglm',
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json',
  Origin: 'https://chatglm.cn',
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  'Sec-Ch-Ua': '"Google Chrome";v="151", "Chromium";v="151", "Not=A?Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'X-App-Fr': 'default',
  'X-App-Platform': 'pc',
  'X-App-Version': '0.0.1',
  'X-Device-Brand': '',
  'X-Device-Model': '',
  'X-Lang': 'zh',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
}

interface TokenInfo {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface GLMMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest {
  model: string
  originalModel?: string
  messages: GLMMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoningEffort?: string | boolean
  deep_research?: boolean
  tools?: any[]
  tool_choice?: any
}

export interface GLMRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
  requestId?: string
}

function getGLMRequestTimeout(defaultMs: number, options?: GLMRequestOptions): number {
  const requestedTimeout = options?.timeoutMs
  return requestedTimeout === undefined || !Number.isFinite(requestedTimeout)
    ? defaultMs
    : Math.max(1, Math.min(defaultMs, requestedTimeout))
}

const tokenCache = new Map<string, TokenInfo>()

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export class GLMUpstreamResponseError extends Error {
  readonly status = 502

  constructor(message: string) {
    super(message)
    this.name = 'GLMUpstreamResponseError'
  }
}

function sanitizeGLMUpstreamMessage(value: unknown): string {
  return String(value ?? 'unknown upstream failure')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 600)
}

function getGLMUpstreamFailure(result: any): string | undefined {
  const status = typeof result?.status === 'string' ? result.status.toLowerCase() : ''
  const isFailureStatus = ['intervene', 'error', 'failed', 'fail'].includes(status)
  const lastError = result?.last_error
  const hasLastError = typeof lastError === 'string'
    ? Boolean(lastError.trim())
    : lastError && typeof lastError === 'object'
      ? Object.keys(lastError).length > 0
      : Boolean(lastError)
  if (!isFailureStatus && result?.success !== false && !hasLastError) return undefined

  const detail = result?.last_error?.intervene_text
    ?? result?.last_error?.message
    ?? result?.message
    ?? result?.msg
    ?? result?.last_error
    ?? status
  return sanitizeGLMUpstreamMessage(detail)
}

function mergeGLMResponseParts(current: any[], incoming: unknown): any[] {
  if (!Array.isArray(incoming)) return current
  return incoming.reduce((parts: any[], part: any) => {
    const index = parts.findIndex((existing) => existing.logic_id === part.logic_id)
    return index === -1
      ? [...parts, part]
      : parts.map((existing, existingIndex) => existingIndex === index ? part : existing)
  }, current)
}

export function addGLMTransportNonce(
  messages: Array<{ role: string; content: any[] }>,
  requestId: string,
): Array<{ role: string; content: any[] }> {
  const marker = `<!-- fluxmeld transport request ${requestId}; no semantic meaning; do not repeat -->\n`
  let markerAdded = false

  return messages.map((message) => ({
    ...message,
    content: message.content.map((part: any) => {
      if (markerAdded || part?.type !== 'text' || typeof part.text !== 'string') return part
      markerAdded = true
      return { ...part, text: marker + part.text }
    }),
  }))
}

export function applyGLMGenerationControls<T extends Record<string, unknown>>(
  payload: T,
  temperature?: number,
): T & { temperature?: number; do_sample?: boolean } {
  if (temperature === undefined) return { ...payload }
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
    throw new GLMRequestValidationError('GLM temperature must be a finite number between 0 and 1')
  }

  return {
    ...payload,
    temperature,
    ...(temperature === 0 ? { do_sample: false } : {}),
  }
}

function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex')
}

function generateSign(): { timestamp: string; nonce: string; sign: string } {
  const e = Date.now()
  const A = e.toString()
  const t = A.length
  const o = A.split('').map((c) => Number(c))
  const i = o.reduce((acc, val) => acc + val, 0) - o[t - 2]
  const a = i % 10
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t)
  const nonce = uuid()
  const sign = md5(`${timestamp}-${nonce}-${SIGN_SECRET}`)
  return { timestamp, nonce, sign }
}

export class GLMAdapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getRefreshToken(): string {
    const credentials = this.account.credentials
    return credentials.refresh_token || credentials.token || ''
  }

  private async acquireToken(options?: GLMRequestOptions): Promise<string> {
    throwIfAborted(options?.signal)
    const refreshToken = this.getRefreshToken()
    const cached = tokenCache.get(refreshToken)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.accessToken
    }

    console.log('[GLM] Refreshing Token...')
    const sign = generateSign()
    const response = await axios.post(
      `${GLM_API_BASE}/user-api/user/refresh`,
      {},
      {
        headers: {
          Authorization: `Bearer ${refreshToken}`,
          ...FAKE_HEADERS,
          'X-Device-Id': uuid(),
          'X-Nonce': sign.nonce,
          'X-Request-Id': uuid(),
          'X-Sign': sign.sign,
          'X-Timestamp': sign.timestamp,
        },
        timeout: getGLMRequestTimeout(1800000, options),
        signal: options?.signal,
        validateStatus: () => true,
      }
    )

    console.log('[GLM] Token refresh response status:', response.status)
    const { code, status, message } = response.data || {}
    const isSuccess = code === 0 || status === 0
    if (response.status !== 200 || !isSuccess) {
      const errorMsg = message || `HTTP ${response.status}`
      throw new Error(`Token refresh failed: ${errorMsg}`)
    }

    const { access_token, refresh_token } = response.data.result
    const tokenInfo: TokenInfo = {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + ACCESS_TOKEN_EXPIRES * 1000,
    }
    tokenCache.set(refreshToken, tokenInfo)

    if (refresh_token !== refreshToken) {
      console.log('[GLM] Token updated, saving new token')
      const decryptedCredentials = {
        refresh_token,
      }
      await storeManager.updateAccount(this.account.id, {
        credentials: decryptedCredentials,
      })
    }

    console.log('[GLM] Token refresh successful')
    return access_token
  }

  /**
   * Check if URL is base64 data
   */
  private isBase64Data(url: string): boolean {
    return url.startsWith('data:')
  }

  /**
   * Extract MIME type from base64 data URL
   */
  private extractBase64Format(url: string): string {
    const match = url.match(/^data:([^;]+);/)
    return match ? match[1] : 'application/octet-stream'
  }

  /**
   * Remove base64 data header
   */
  private removeBase64Header(url: string): string {
    return url.replace(/^data:[^;]+;base64,/, '')
  }

  /**
   * Upload file to GLM
   */
  private async uploadFile(
    fileUrl: string,
    options?: GLMRequestOptions,
  ): Promise<{ source_id: string; file_url?: string }> {
    throwIfAborted(options?.signal)
    console.log('[GLM] Uploading file:', fileUrl.substring(0, 50) + '...')
    
    let filename: string
    let fileData: Buffer
    let mimeType: string

    if (this.isBase64Data(fileUrl)) {
      mimeType = this.extractBase64Format(fileUrl)
      const ext = mime.extension(mimeType) || 'bin'
      filename = `${uuid()}.${ext}`
      fileData = Buffer.from(this.removeBase64Header(fileUrl), 'base64')
    } else {
      filename = path.basename(fileUrl.split('?')[0])
      const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        maxContentLength: FILE_MAX_SIZE,
        timeout: getGLMRequestTimeout(1800000, options),
        signal: options?.signal,
      })
      fileData = Buffer.from(response.data)
      mimeType = response.headers['content-type'] || mime.lookup(filename) || 'application/octet-stream'
    }

    const formData = new FormData()
    formData.append('file', fileData, {
      filename,
      contentType: mimeType,
    })

    const token = await this.acquireToken(options)
    const response = await axios.post(
      `${GLM_API_BASE}/backend-api/assistant/file_upload`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Referer: 'https://chatglm.cn/',
          ...FAKE_HEADERS,
          ...formData.getHeaders(),
        },
        maxBodyLength: FILE_MAX_SIZE,
        timeout: getGLMRequestTimeout(1800000, options),
        signal: options?.signal,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200 || !response.data?.result) {
      throw new Error(`File upload failed: HTTP ${response.status}`)
    }

    console.log('[GLM] File uploaded successfully:', response.data.result.source_id)
    return response.data.result
  }

  /**
   * Extract file URLs from message content
   */
  private extractFileUrls(messages: GLMMessage[]): { fileUrls: string[]; imageUrls: string[] } {
    const fileUrls: string[] = []
    const imageUrls: string[] = []

    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'image_url' && part.image_url?.url) {
            imageUrls.push(part.image_url.url)
          } else if (part.type === 'file' && part.file_url?.url) {
            fileUrls.push(part.file_url.url)
          }
        }
      }
    }

    return { fileUrls, imageUrls }
  }

  private messagesToPrompt(messages: GLMMessage[], refs: any[] = [], toolsPrompt?: string, isMultiTurn: boolean = false): { role: string; content: any[] }[] {
    const toolProfile = getProviderToolProfile('glm')
    // Separate image refs and file refs
    const imageRefs = refs.filter((ref) => ref.width !== undefined || ref.height !== undefined || ref.image_url)
    const fileRefs = refs.filter((ref) => !ref.width && !ref.height && !ref.image_url)

    // Build content array
    const content: any[] = []

    // Add file references first
    if (fileRefs.length > 0) {
      content.push({
        type: 'file',
        file: fileRefs.map((ref) => ({
          source_id: ref.source_id,
          file_url: ref.file_url,
        })),
      })
    }

    // Add image references
    for (const imageRef of imageRefs) {
      content.push({
        type: 'image_url',
        image_url: {
          url: imageRef.image_url || imageRef.source_id,
        },
      })
    }

    // Process messages including tool calls and tool responses
    const processedMessages = messages.map(msg => {
      // Handle tool calls in assistant message
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          ...msg,
          content: toolProfile.formatAssistantToolCalls(msg.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          }))),
        }
      }
      // Handle tool response message
      if (msg.role === 'tool' && msg.tool_call_id) {
        return { 
          ...msg, 
          role: 'user' as const,
          content: toolProfile.formatToolResult({
            toolCallId: msg.tool_call_id,
            content: String(msg.content || ''),
          }),
        }
      }
      return msg
    })

    // For multi-turn mode, only send the last user message
    if (isMultiTurn) {
      let lastUserIdx = -1
      for (let i = processedMessages.length - 1; i >= 0; i--) {
        if (processedMessages[i].role === 'user') {
          lastUserIdx = i
          break
        }
      }
      
      if (lastUserIdx !== -1) {
        const lastUserMsg = processedMessages[lastUserIdx]
        let textContent = ''
        if (typeof lastUserMsg.content === 'string') {
          textContent = lastUserMsg.content
        } else if (Array.isArray(lastUserMsg.content)) {
          textContent = lastUserMsg.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        }
        
        // Include any tool results after the last user message
        for (let i = lastUserIdx + 1; i < processedMessages.length; i++) {
          if (processedMessages[i].role === 'user') {
            const toolText = typeof processedMessages[i].content === 'string' 
              ? processedMessages[i].content 
              : ''
            textContent += '\n' + toolText
          }
        }
        
        if (toolsPrompt) {
          textContent = textContent.trim() + "\n\n" + toolsPrompt
        }
        
        content.push({ type: 'text', text: textContent })
        return [{ role: 'user', content }]
      }
    }

    // Extract text from messages
    if (processedMessages.length < 2) {
      let textContent = processedMessages.reduce((acc, msg) => {
        if (typeof msg.content === 'string') {
          return acc + msg.content + '\n'
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter((c) => c.type === 'text').map((c) => c.text)
          return acc + textParts.join('') + '\n'
        }
        return acc
      }, '')

      // Inject tools prompt at the VERY END
      if (toolsPrompt) {
        textContent = textContent.trim() + "\n\n" + toolsPrompt
      }

      content.push({ type: 'text', text: textContent })
      return [{ role: 'user', content }]
    }

    let textContent = processedMessages.reduce((acc, msg) => {
      const role = msg.role
        .replace('system', 'System')
        .replace('assistant', 'Assistant')
        .replace('user', 'User')
        .replace('tool', 'User')
      if (typeof msg.content === 'string') {
        return acc + `${role}: ${msg.content}\n\n`
      } else if (Array.isArray(msg.content)) {
        const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        return acc + `${role}: ${text}\n\n`
      }
      return acc
    }, '')

    // Inject tools prompt at the VERY END
    if (toolsPrompt) {
      textContent = textContent.trim() + "\n\n" + toolsPrompt
    }

    content.push({ type: 'text', text: textContent + 'Assistant: ' })
    return [{ role: 'user', content }]
  }

  async chatCompletion(
    request: ChatCompletionRequest,
    options?: GLMRequestOptions,
  ): Promise<{ response: AxiosResponse; conversationId: string }> {
    throwIfAborted(options?.signal)
    const token = await this.acquireToken(options)
    const sign = generateSign()

    // Clone messages to avoid modifying original request
    const messages = [...request.messages]

    // Check if tool prompt has already been injected by client
    const toolPromptExists = hasToolPromptInjected(messages)

    // Inject tools definition into prompt if tools are provided and not already injected
    let toolsPrompt = ''
    if (request.tools && request.tools.length > 0 && !toolPromptExists) {
      const glmStrictHint = `

GLM STRICT RULES:
- If user asks to create/modify code or files, you MUST call tools instead of replying with plain text.
- You MUST output ONLY one [function_calls] block when calling tools.
- Use exact tool names from list, case-sensitive, do not rename.`
      toolsPrompt = toolsToSystemPrompt(request.tools) + glmStrictHint

      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const currentContent = messages[i].content
          if (typeof currentContent === 'string') {
            messages[i] = { ...messages[i], content: currentContent + TOOL_WRAP_HINT }
          } else if (Array.isArray(currentContent)) {
            messages[i] = {
              ...messages[i],
              content: [...currentContent, { type: 'text', text: TOOL_WRAP_HINT }],
            }
          }
          break
        }
      }
    }

    // Extract and upload files
    const { fileUrls, imageUrls } = this.extractFileUrls(messages)
    const refs: any[] = []

    // Upload files
    for (const fileUrl of fileUrls) {
      try {
        const result = await this.uploadFile(fileUrl, options)
        refs.push({
          source_id: result.source_id,
          file_url: result.file_url || fileUrl,
        })
      } catch (error) {
        if (options?.signal?.aborted) throw getAbortReason(options.signal)
        console.error('[GLM] Failed to upload file:', error)
      }
    }

    // Upload images
    for (const imageUrl of imageUrls) {
      try {
        const result = await this.uploadFile(imageUrl, options)
        refs.push({
          source_id: result.source_id,
          image_url: result.file_url || imageUrl,
          width: 0,
          height: 0,
        })
      } catch (error) {
        if (options?.signal?.aborted) throw getAbortReason(options.signal)
        console.error('[GLM] Failed to upload image:', error)
      }
    }

    throwIfAborted(options?.signal)

    const transportRequestId = uuid()
    const preparedMessages = addGLMTransportNonce(
      this.messagesToPrompt(messages, refs, toolsPrompt, false),
      transportRequestId,
    )

    let assistantId = DEFAULT_ASSISTANT_ID
    let reasoningEffort = request.reasoningEffort
    let isNetworking = false

    if (request.web_search) {
      isNetworking = true
      console.log('[GLM] Web search enabled')
    }

    // Fall back to model-name aliases when the caller did not specify effort.
    const modelForDetection = request.originalModel || request.model
    const modelLower = modelForDetection.toLowerCase()
    if (reasoningEffort === undefined) {
      if (
        modelLower.includes('deepthink')
        || modelLower.includes('deep-thinking')
        || modelLower.includes('deep_thinking')
      ) {
        reasoningEffort = 'max'
      } else if (modelLower.includes('think') || modelLower.includes('zero')) {
        reasoningEffort = 'high'
      } else if (modelLower.includes('fast')) {
        reasoningEffort = 'none'
      }
    }

    let chatMode: GLMChatMode | 'deep_research' = resolveGLMChatMode(reasoningEffort)
    if (request.deep_research || modelLower.includes('deepresearch')) {
      chatMode = 'deep_research'
      console.log('[GLM] Using deep research mode')
    } else {
      console.log('[GLM] Using GLM-5.2 thinking mode:', chatMode || 'fast')
    }
    
    // Check if model is an assistant ID (24+ alphanumeric characters)
    if (/^[a-z0-9]{24,}$/.test(request.model)) {
      assistantId = request.model
    }

    console.log('[GLM] Sending chat request...')
    
    const response = await axios.post(
      `${GLM_API_BASE}/backend-api/assistant/stream`,
      applyGLMGenerationControls({
        assistant_id: assistantId,
        conversation_id: '',
        project_id: '',
        chat_type: 'user_chat',
        messages: preparedMessages,
        meta_data: {
          channel: '',
          chat_mode: chatMode,
          draft_id: '',
          input_question_type: 'xxxx',
          is_networking: isNetworking,
          is_test: false,
          platform: 'pc',
          quote_log_id: '',
          request_id: transportRequestId,
          cogview: {
            rm_label_watermark: false,
          },
        },
      }, request.temperature),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          'X-Device-Id': uuid(),
          'X-Request-Id': transportRequestId,
          'X-Sign': sign.sign,
          'X-Timestamp': sign.timestamp,
          'X-Nonce': sign.nonce,
        },
        timeout: getGLMRequestTimeout(1800000, options),
        signal: options?.signal,
        validateStatus: () => true,
        responseType: 'stream',
      }
    )

    return { response, conversationId: '' }
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const sign = generateSign()
      await axios.post(
        `${GLM_API_BASE}/backend-api/assistant/conversation/delete`,
        {
          assistant_id: DEFAULT_ASSISTANT_ID,
          conversation_id: conversationId,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: 'https://chatglm.cn/main/alltoolsdetail',
            'X-Device-Id': uuid(),
            'X-Request-Id': uuid(),
            'X-Sign': sign.sign,
            'X-Timestamp': sign.timestamp,
            'X-Nonce': sign.nonce,
            ...FAKE_HEADERS,
          },
          timeout: 1800000,
          validateStatus: () => true,
        }
      )
      console.log('[GLM] Conversation deleted:', conversationId)
      return true
    } catch (error) {
      console.error('[GLM] Failed to delete conversation:', error)
      return false
    }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      const token = await this.acquireToken()

      // Step 1: Get all conversations (handle pagination)
      const allConversationIds: string[] = []
      let page = 1
      let hasMore = true

      while (hasMore) {
        const sign = generateSign()
        const listResponse = await axios.post(
          `${GLM_API_BASE}/mainchat-api/conversation/recent_list`,
          { page, page_size: 100 },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Referer: 'https://chatglm.cn/main/alltoolsdetail',
              'X-Device-Id': uuid(),
              'X-Request-Id': uuid(),
              'X-Sign': sign.sign,
              'X-Timestamp': sign.timestamp,
              'X-Nonce': sign.nonce,
              ...FAKE_HEADERS,
            },
            timeout: 1800000,
            validateStatus: () => true,
          }
        )

        console.log('[GLM] Get conversation list page', page, 'response:', JSON.stringify(listResponse.data, null, 2))

        const { status, result } = listResponse.data || {}
        if (listResponse.status !== 200 || status !== 0) {
          console.error('[GLM] Failed to get conversation list')
          return false
        }

        const conversationList = result?.conversation_list || []
        for (const c of conversationList) {
          allConversationIds.push(c.conversation_id)
        }

        hasMore = result?.has_more || false
        page++

        if (conversationList.length === 0) {
          break
        }
      }

      if (allConversationIds.length === 0) {
        console.log('[GLM] No conversations to delete')
        return true
      }

      console.log('[GLM] Found', allConversationIds.length, 'conversations to delete')

      // Step 2: Bulk delete conversations
      const sign = generateSign()
      const deleteResponse = await axios.post(
        `${GLM_API_BASE}/mainchat-api/conversation/bulk_delete`,
        { conversation_ids: allConversationIds },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: 'https://chatglm.cn/main/alltoolsdetail',
            'X-Device-Id': uuid(),
            'X-Request-Id': uuid(),
            'X-Sign': sign.sign,
            'X-Timestamp': sign.timestamp,
            'X-Nonce': sign.nonce,
            ...FAKE_HEADERS,
          },
          timeout: 1800000,
          validateStatus: () => true,
        }
      )

      console.log('[GLM] Bulk delete response:', JSON.stringify(deleteResponse.data, null, 2))

      const deleteResult = deleteResponse.data || {}
      const success = deleteResponse.status === 200 && deleteResult.status === 0
      if (success) {
        console.log('[GLM] All chats deleted')
      }
      return success
    } catch (error) {
      console.error('[GLM] Failed to delete all chats:', error)
      return false
    }
  }

  static isGLMProvider(provider: Provider): boolean {
    return provider.id === 'glm' || provider.apiEndpoint.includes('chatglm.cn')
  }
}

export class GLMStreamHandler {
  private conversationId: string = ''
  private model: string
  private created: number
  private onEnd?: () => void
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan

  constructor(model: string, onEnd?: () => void, initialConversationId?: string, toolCallingPlan?: ToolCallingPlan) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
    if (initialConversationId) {
      this.conversationId = initialConversationId
    }
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()
    let responseParts: any[] = []
    let sentContent = ''
    let sentReasoning = ''
    let sentRole = false
    let completed = false

    const failStream = (error: Error): void => {
      if (completed) return
      completed = true
      console.error('[GLM] Upstream stream failed:', error.message)
      transStream.destroy(error)
      this.onEnd?.()
    }

    transStream.write(
      `data: ${JSON.stringify({
        id: '',
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        created: this.created,
      })}\n\n`
    )

    const parser = createParser({
      onEvent: (event: any) => {
        try {
          const result = JSON.parse(event.data)

          if (completed) return

          const upstreamFailure = getGLMUpstreamFailure(result)
          if (upstreamFailure) {
            failStream(new GLMUpstreamResponseError(`GLM upstream rejected the response: ${upstreamFailure}`))
            return
          }

          if (!this.conversationId && result.conversation_id) {
            this.conversationId = result.conversation_id
          }

          responseParts = mergeGLMResponseParts(responseParts, result.parts)

          if (result.status !== 'finish') {

            const searchMap = new Map<string, any>()
            responseParts.forEach((part) => {
              if (!part.content || !Array.isArray(part.content)) return
              const { meta_data } = part
              part.content.forEach((item: any) => {
                if (item.type === 'tool_result' && meta_data?.tool_result_extra?.search_results) {
                  meta_data.tool_result_extra.search_results.forEach((res: any) => {
                    if (res.match_key) {
                      searchMap.set(res.match_key, res)
                    }
                  })
                }
              })
            })

            const keyToIdMap = new Map<string, number>()
            let counter = 1
            let fullText = ''
            let fullReasoning = ''

            responseParts.forEach((part) => {
              const { content, meta_data } = part
              if (!Array.isArray(content)) return

              let partText = ''
              let partReasoning = ''

              content.forEach((value: any) => {
                const { type, text, think, image, code, content: innerContent } = value

                if (type === 'text') {
                  let txt = text
                  if (searchMap.size > 0) {
                    txt = txt.replace(/【?(turn\d+[a-zA-Z]+\d+)】?/g, (match: string, key: string) => {
                      const searchInfo = searchMap.get(key)
                      if (!searchInfo) return match
                      if (!keyToIdMap.has(key)) {
                        keyToIdMap.set(key, counter++)
                      }
                      return ` [${keyToIdMap.get(key)}](${searchInfo.url})`
                    })
                  }
                  partText += txt
                } else if (type === 'think') {
                  partReasoning += think
                } else if (type === 'image' && Array.isArray(image) && part.status === 'finish') {
                  const imageText =
                    image.reduce((imgs: string, v: any) => {
                      return imgs + (/^(http|https):\/\//.test(v.image_url) ? `![image](${v.image_url})` : '')
                    }, '') + '\n'
                  partText += imageText
                } else if (type === 'code') {
                  partText += '```python\n' + code + (part.status === 'finish' ? '\n```\n' : '')
                } else if (type === 'execution_output' && typeof innerContent === 'string' && part.status === 'finish') {
                  partText += innerContent + '\n'
                }
              })

              if (partText) fullText += (fullText.length > 0 ? '\n' : '') + partText
              if (partReasoning) fullReasoning += (fullReasoning.length > 0 ? '\n' : '') + partReasoning
            })

            const reasoningChunk = fullReasoning.substring(sentReasoning.length)
            if (reasoningChunk) {
              sentReasoning += reasoningChunk
              transStream.write(
                `data: ${JSON.stringify({
                  id: this.conversationId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { reasoning_content: reasoningChunk }, finish_reason: null }],
                  created: this.created,
                })}\n\n`
              )
            }

            const chunk = fullText.substring(sentContent.length)
            if (chunk) {
              sentContent += chunk
            }
            
            // Process tool call interception with shared parser buffering.
            const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
            const outputChunks = this.toolStreamParser?.push(chunk, baseChunk, !sentRole) ?? (
              chunk ? [{
                ...baseChunk,
                choices: [{ index: 0, delta: { ...(!sentRole ? { role: 'assistant' } : {}), content: chunk }, finish_reason: null }],
              }] : []
            )

            for (const outChunk of outputChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }

            if (outputChunks.length > 0) sentRole = true
          } else {
            completed = true
            // Flush any remaining tool call buffer before finishing
            const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
            const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
            for (const outChunk of flushChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }

            // Determine finish_reason based on whether we had tool calls
            const finishReason = this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop'

            transStream.write(
              `data: ${JSON.stringify({
                id: this.conversationId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: finishReason,
                  },
                ],
                created: this.created,
              })}\n\n`
            )
            transStream.end('data: [DONE]\n\n')
            this.onEnd?.()
          }
        } catch (err) {
          failStream(err instanceof Error ? err : new Error(String(err)))
        }
      },
    })

    const decoder = new TextDecoder('utf-8')
    stream.on('data', (buffer: Buffer) => parser.feed(decoder.decode(buffer, { stream: true })))

    stream.once('error', (err: Error) => {
      failStream(new GLMUpstreamResponseError(`GLM upstream stream error: ${sanitizeGLMUpstreamMessage(err.message)}`))
    })

    const failIncompleteStream = (): void => failStream(
      new GLMUpstreamResponseError('GLM upstream response ended before a finish event'),
    )
    stream.once('end', failIncompleteStream)
    stream.once('close', failIncompleteStream)

    return transStream
  }

  async handleNonStream(stream: any, options?: GLMRequestOptions): Promise<any> {
    return new Promise((resolve, reject) => {
      let responseParts: any[] = []
      let settled = false
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined

      const onData = (buffer: Buffer): void => parser.feed(buffer.toString())
      const onError = (error: Error): void => failResponse(
        new GLMUpstreamResponseError(`GLM upstream stream error: ${sanitizeGLMUpstreamMessage(error.message)}`),
      )
      const onTransportEnd = (): void => failResponse(
        new GLMUpstreamResponseError('GLM upstream response ended before a finish event'),
      )
      const onAbort = (): void => {
        if (options?.signal) failResponse(getAbortReason(options.signal))
      }

      const cleanup = (): void => {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        options?.signal?.removeEventListener('abort', onAbort)
        stream.off?.('data', onData)
        stream.off?.('error', onError)
        stream.off?.('end', onTransportEnd)
        stream.off?.('close', onTransportEnd)
      }

      const destroyUpstream = (): void => {
        if (typeof stream.destroy === 'function' && !stream.destroyed) stream.destroy()
      }

      const failResponse = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        destroyUpstream()
        reject(error)
      }

      const parser = createParser({
        onEvent: (event: any) => {
          try {
            const result = JSON.parse(event.data)

            if (settled) return

            const upstreamFailure = getGLMUpstreamFailure(result)
            if (upstreamFailure) {
              failResponse(new GLMUpstreamResponseError(`GLM upstream rejected the response: ${upstreamFailure}`))
              return
            }

            if (!this.conversationId && result.conversation_id) {
              this.conversationId = result.conversation_id
            }

            responseParts = mergeGLMResponseParts(responseParts, result.parts)

            if (result.status !== 'finish') {
              return
            } else {
              const searchMap = new Map<string, any>()
              responseParts.forEach((part) => {
                if (!part.content || !Array.isArray(part.content)) return
                const { meta_data } = part
                part.content.forEach((item: any) => {
                  if (item.type === 'tool_result' && meta_data?.tool_result_extra?.search_results) {
                    meta_data.tool_result_extra.search_results.forEach((res: any) => {
                      if (res.match_key) {
                        searchMap.set(res.match_key, res)
                      }
                    })
                  }
                })
              })

              const keyToIdMap = new Map<string, number>()
              let counter = 1
              let fullText = ''
              let fullReasoning = ''

              responseParts.forEach((part) => {
                const { content, meta_data } = part
                if (!Array.isArray(content)) return

                let partText = ''
                let partReasoning = ''

                content.forEach((value: any) => {
                  const { type, text, think, image, code, content: innerContent } = value

                  if (type === 'text') {
                    let txt = text
                    if (searchMap.size > 0) {
                      txt = txt.replace(/【?(turn\d+[a-zA-Z]+\d+)】?/g, (match: string, key: string) => {
                        const searchInfo = searchMap.get(key)
                        if (!searchInfo) return match
                        if (!keyToIdMap.has(key)) {
                          keyToIdMap.set(key, counter++)
                        }
                        return ` [${keyToIdMap.get(key)}](${searchInfo.url})`
                      })
                    }
                    partText += txt
                  } else if (type === 'think') {
                    partReasoning += think
                  } else if (type === 'image' && Array.isArray(image) && part.status === 'finish') {
                    const imageText =
                      image.reduce((imgs: string, v: any) => {
                        return imgs + (/^(http|https):\/\//.test(v.image_url) ? `![image](${v.image_url})` : '')
                      }, '') + '\n'
                    partText += imageText
                  } else if (type === 'code') {
                    partText += '```python\n' + code + '\n```\n'
                  } else if (type === 'execution_output' && typeof innerContent === 'string' && part.status === 'finish') {
                    partText += innerContent + '\n'
                  }
                })

                if (partText) fullText += (fullText.length > 0 ? '\n' : '') + partText
                if (partReasoning) fullReasoning += (fullReasoning.length > 0 ? '\n' : '') + partReasoning
              })

              const { content: cleanContent, toolCalls } = this.toolCallingPlan?.shouldParseResponse
                ? { content: fullText, toolCalls: [] }
                : parseToolCallsFromText(fullText, 'glm')

              settled = true
              cleanup()
              destroyUpstream()
              resolve({
                id: this.conversationId,
                model: this.model,
                object: 'chat.completion',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: toolCalls.length > 0 ? null : cleanContent.trim(),
                      reasoning_content: fullReasoning || null,
                      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
                    },
                    finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
                  },
                ],
                created: Math.floor(Date.now() / 1000),
              })
            }
          } catch (err) {
            failResponse(err instanceof Error ? err : new Error(String(err)))
          }
        },
      })

      if (options?.signal?.aborted) {
        onAbort()
        return
      }

      options?.signal?.addEventListener('abort', onAbort, { once: true })
      stream.once('error', onError)
      stream.once('end', onTransportEnd)
      stream.once('close', onTransportEnd)

      const timeoutMs = getGLMRequestTimeout(1800000, options)
      timeoutHandle = setTimeout(() => failResponse(
        new RequestTimeoutError(
          options?.requestId ?? 'unknown',
          timeoutMs,
          'GLM upstream response',
        ),
      ), timeoutMs)

      // Registering a data listener may synchronously start a custom Readable,
      // so install every settle/cleanup path before consumption begins.
      stream.on('data', onData)
    })
  }

  getConversationId(): string {
    return this.conversationId
  }
}

export const glmAdapter = {
  GLMAdapter,
  GLMStreamHandler,
}
