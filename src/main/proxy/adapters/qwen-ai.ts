/**
 * Qwen AI International Adapter
 * Implements chat.qwen.ai API protocol
 * Based on qwen3-reverse project
 */

import axios, { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import type { Account, Provider } from '../../store/types'
import { hasToolUse, parseToolUse } from '../promptToolUse'
import { getToolProtocol } from '../toolCalling/protocols'
import type { ToolProtocolId } from '../toolCalling/types'

const QWEN_AI_BASE = 'https://chat.qwen.ai'
const QWEN_AI_WEB_VERSION = '0.2.35'
const EMPTY_RESPONSE_ERROR = 'Qwen upstream completed without assistant content'

const DEFAULT_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Content-Type': 'application/json',
  source: 'web',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'bx-v': '2.5.36',
  'bx-umidtoken': 'T2gAr9z8byN8sNOmfQ3X9j61MNTNmSqDO5L1rs2jMcQCVhOKgZICcBN-UdTuJGig-NM=',
  'bx-ua': '231!lWD36kmUe5E+joKDK5gBZ48FEl2ZWfPwIPF92lBLek2KxVW/XJ2EwruCiDOX5Px4EXNhmh6EfS9eDwQGRwijIK64A4nPqeLysJcDjUACje/H3J4ZgGZpicG6K8AkiGGaEKC830+QSiSUsLRlL/EyhXTmLcJc/5iDkMuOpUhNz0e0Q/nTqjVJ3ko00Q/oyE+jauHhUHfb1GxGHkE+++3+qCS4+ItkaA6tiItCo+romzElfLFD6RIj7oHt9vffs98nLwpHnaqKjufnLFMejSlAUGiQvTofIiGhIvftAMcoFV4mrUHsqyQ/ncQihmJHkbxXjvM57FCb6b9dEIRZl7jgj0+QLNLRs0NZ4azdZ6rzbGTSO8KA5I3Aq/3gBr87X16Mj0oJtaPKmFGaP2zghfOVhxQht8YjRd50lJa+Ue4PAuPSdu2O69DKLH8VOhrsB+psaBIRxnRi5POUQ6w8s8qlb9vxvExjHNOAKWXV1by1Nz+6FPWdyTeAgcmonjCcV0dCtPj/KyeVDkeSrDkKZjnDzHEqeCdfmJ65kve+Vy3YS0vagzyHfVEnzN0ULUZtkGfJXFNm6+bIa55wmGBhUeXbHL0EdlQXMu1YXxmcwBgTaq7tlQcfv7AefanbfjGE8R1IFnNyg2/jXLbnLg5Z6l1oKqgnxZQg0DE9BJuw6s0XjGwTdSxybWxp+WFD/RsXt76uwvCBk7z+YmSFLtFj2UlTsoq+vl0DTmsVItDKf9SZ94NcuJ7mxJYI02S/2kQBfbbHG0d4hXevDrEC0cb86EvzN2ud+v6bAunNRGNFz/RH0KLusoBVeo+puCFKeeIJWEo0t1UicX5YxJwMAoV7+g0gK93y4W9sMQtso8/wY5wsBzis9dwfLvIwXpaAM1g0MZp/YIRq8T/Qc+U/8x99tam4er0IWizvrkjqhIzCWBKpJ4Y4gj3bOmiS3VCMEaoVfKCwUWENwYKuP3H5VI0n+O2vVVRrekUrwvkm6URRhVhN4eEFTCjB9nSQu++qKyDH8HPpkS3YfwF8/OQtrZo7hQXxvNmP2HcH/K7zcweD00BaoOLiYUtXRItGYbl06sVSbm04soRf1Jqpyo3XiRqBWD9rmJfr4w8NOEGVGUCKXLDLsXy+8JC4Iqf0FsIjWxjMVdraTUtCbwXRbYUownQVm6bt7LYD1SNPoWNPqUJgsLMwP33ugrb1UbHCs24roOch6Go5QHIPA8E15SZE9pkr1SkmqrNs/+KRomFJ9HyFnWUYhZIV9MRLqlOAt6XBBTash3WJnCjhx/PZGhXVvdn2jX4+0Pm55LsiNugA8vaAUJQBxD/8a1u/RvTgbj35+b7I7m8tG0hMhClNZF+tpsOmZZhUGuXH9uVbkJMlMuAmMVCHwn3O31GlLeXXzzep2WS3xN2U+p5J0I7GySnuZUkuGs1ZTVqGUvR2g4q+7ljU55Ak78yPZiQXeUeqS74azszvZvCqWxXn2eePj+gcpliOjrYKpglUP19rQrMt8PqLt8L0ghIqVCmMwl3Hgr/VUcqDpXdpPTR=',
  Version: QWEN_AI_WEB_VERSION,
  Origin: 'https://chat.qwen.ai',
}

function getUpstreamError(data: any): string | null {
  if (!data || typeof data !== 'object') return null

  if (typeof data.error === 'string' && data.error.trim()) {
    return data.error.trim()
  }

  if (data.error && typeof data.error === 'object') {
    const nestedMessage = data.error.message || data.error.msg || data.error.detail
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
      return nestedMessage.trim()
    }
  }

  if (data.success === false || (data.code && !data.choices && !data['response.created'])) {
    const message = data.message || data.msg || data.detail || data.code
    if (typeof message === 'string' && message.trim()) {
      return message.trim()
    }
  }

  return null
}

function createUpstreamError(message: string): Error {
  return new Error(`Qwen upstream error: ${message}`)
}

interface OpenAiUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

function normalizeUsage(usage: any): OpenAiUsage | null {
  if (!usage || typeof usage !== 'object') return null

  const hasPromptTokens = usage.prompt_tokens !== undefined || usage.input_tokens !== undefined
  const hasCompletionTokens = usage.completion_tokens !== undefined || usage.output_tokens !== undefined
  if (!hasPromptTokens || !hasCompletionTokens) return null

  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens)
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens)
  const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens)

  if (![promptTokens, completionTokens, totalTokens].every(Number.isFinite)) {
    return null
  }

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  }
}

const MODEL_ALIASES: Record<string, string> = {
  qwen: 'qwen3.7-max',
  qwen3: 'qwen3.7-max',
  'qwen3.7': 'qwen3.7-max',
  'qwen3.6': 'qwen3.6-plus',
  'qwen3.6-35b': 'qwen3.6-35b-a3b',
  'qwen3.6-27b': 'qwen3.6-27b',
  'qwen3-coder': 'qwen3-coder-plus',
}

interface QwenAiMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    function: { name: string; arguments: string }
  }>
}

interface ChatCompletionRequest {
  model: string
  /** Original model name before mapping (used for feature detection like thinking mode) */
  originalModel?: string
  messages: QwenAiMessage[]
  stream?: boolean
  temperature?: number
  enable_thinking?: boolean
  thinking_budget?: number
  reasoning_effort?: string | boolean
  max_tokens?: number
  max_completion_tokens?: number
  toolProtocol?: ToolProtocolId
  chatId?: string
}

export interface QwenAiRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export class QwenAiRequestValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QwenAiRequestValidationError'
  }
}

export interface QwenAiGenerationSettings {
  enableThinking: boolean
  thinkingBudget?: number
  maxTokens?: number
  maxCompletionTokens?: number
}

export interface QwenAiOutputLimits {
  maxTokens?: number
  maxCompletionTokens?: number
}

export type QwenAiUpstreamCompletionState = 'complete' | 'output_limit' | 'incomplete'

const QWEN_REASONING_BUDGETS: Record<string, number> = {
  minimal: 512,
  low: 1024,
  enabled: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 16384,
}

const DEFAULT_QWEN_THINKING_BUDGET = 4096
const DISABLED_REASONING_VALUES = new Set(['none', 'off', 'disabled', 'false'])

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new QwenAiRequestValidationError(`${field} must be a positive integer`)
  }

  return value
}

/**
 * Resolve OpenAI-style generation controls to Qwen Web controls.
 * Model suffixes remain authoritative: `-thinking` forces thinking while
 * `-fast` forces it off. Explicit Qwen parameters take precedence over the
 * compatibility `reasoning_effort` field when no suffix is present.
 */
export function resolveQwenAiGenerationSettings(
  request: Pick<
    ChatCompletionRequest,
    'enable_thinking' | 'thinking_budget' | 'reasoning_effort' | 'max_tokens' | 'max_completion_tokens'
  >,
  forceThinking?: boolean
): QwenAiGenerationSettings {
  if (request.enable_thinking !== undefined && typeof request.enable_thinking !== 'boolean') {
    throw new QwenAiRequestValidationError('enable_thinking must be a boolean')
  }

  const thinkingBudget = optionalPositiveInteger(request.thinking_budget, 'thinking_budget')
  const maxTokens = optionalPositiveInteger(request.max_tokens, 'max_tokens')
  const maxCompletionTokens = optionalPositiveInteger(
    request.max_completion_tokens,
    'max_completion_tokens'
  )

  let effortEnablesThinking: boolean | undefined
  let effortBudget: number | undefined
  const rawEffort = request.reasoning_effort

  if (typeof rawEffort === 'boolean') {
    effortEnablesThinking = rawEffort
  } else if (typeof rawEffort === 'string') {
    const effort = rawEffort.trim().toLowerCase()
    if (DISABLED_REASONING_VALUES.has(effort)) {
      effortEnablesThinking = false
    } else if (QWEN_REASONING_BUDGETS[effort] !== undefined) {
      effortEnablesThinking = true
      effortBudget = QWEN_REASONING_BUDGETS[effort]
    } else {
      throw new QwenAiRequestValidationError(
        `Unsupported reasoning_effort for Qwen AI: ${rawEffort}`
      )
    }
  } else if (rawEffort !== undefined && rawEffort !== null) {
    throw new QwenAiRequestValidationError('reasoning_effort must be a string or boolean')
  }

  const enableThinking = forceThinking
    ?? request.enable_thinking
    ?? effortEnablesThinking
    ?? false

  let resolvedThinkingBudget = enableThinking
    ? (thinkingBudget ?? effortBudget ?? DEFAULT_QWEN_THINKING_BUDGET)
    : undefined

  // Qwen Web does not expose OpenAI's total completion limit as a native UI
  // control. Keep enough of the requested total budget for an actual answer,
  // then use the stream handler below as the final usage-based guard.
  if (resolvedThinkingBudget !== undefined && maxCompletionTokens !== undefined) {
    const answerReserve = Math.max(1, Math.min(512, Math.floor(maxCompletionTokens / 4)))
    const maximumThinkingBudget = Math.max(1, maxCompletionTokens - answerReserve)
    resolvedThinkingBudget = Math.min(resolvedThinkingBudget, maximumThinkingBudget)
  }

  return {
    enableThinking,
    ...(resolvedThinkingBudget !== undefined && { thinkingBudget: resolvedThinkingBudget }),
    ...(maxTokens !== undefined && { maxTokens }),
    ...(maxCompletionTokens !== undefined && { maxCompletionTokens }),
  }
}

export function buildQwenAiFeatureConfig(
  settings: QwenAiGenerationSettings
): Record<string, unknown> {
  return {
    thinking_enabled: settings.enableThinking,
    output_schema: 'phase',
    research_mode: 'normal',
    auto_thinking: settings.enableThinking,
    thinking_format: 'summary',
    auto_search: false,
    ...(settings.thinkingBudget !== undefined && {
      thinking_budget: settings.thinkingBudget,
    }),
  }
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function timestamp(): number {
  return Date.now()
}

function extractTextContent(content: QwenAiMessage['content']): string {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    return content
      .filter(item => item?.type === 'text' && typeof item.text === 'string')
      .map(item => item.text)
      .join('\n')
  }

  return ''
}

export function buildQwenAiPrompt(
  messages: QwenAiMessage[],
  toolProtocol: ToolProtocolId = 'managed_xml',
): string {
  const protocol = getToolProtocol(toolProtocol)
  const systemParts: string[] = []
  const conversationParts: string[] = []

  for (const message of messages) {
    const text = extractTextContent(message.content)

    if (message.role === 'system') {
      if (text) systemParts.push(text)
    } else if (message.role === 'user') {
      if (text) conversationParts.push(`User: ${text}`)
    } else if (message.role === 'assistant' && message.tool_calls?.length) {
      conversationParts.push(protocol.formatAssistantToolCalls(
        message.tool_calls.map(toolCall => ({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        }))
      ))
    } else if (message.role === 'assistant') {
      if (text) conversationParts.push(`Assistant: ${text}`)
    } else if (message.role === 'tool' && message.tool_call_id) {
      conversationParts.push(protocol.formatToolResult({
        toolCallId: message.tool_call_id,
        content: text,
      }))
    } else if (message.role === 'tool' && text) {
      conversationParts.push(`Tool: ${text}`)
    }
  }

  return [...systemParts, ...conversationParts].join('\n\n')
}

export class QwenAiAdapter {
  private provider: Provider
  private account: Account
  private axiosInstance = axios.create({
    timeout: 1800000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getToken(): string {
    const credentials = this.account.credentials
    return credentials.token || credentials.accessToken || credentials.apiKey || ''
  }

  private getCookies(): string {
    const credentials = this.account.credentials
    return credentials.cookies || credentials.cookie || ''
  }

  private getHeaders(chatId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      Timezone: new Date().toUTCString(),
      Authorization: `Bearer ${this.getToken()}`,
      'X-Request-Id': uuid(),
    }

    if (chatId) {
      headers['Referer'] = `https://chat.qwen.ai/c/${chatId}`
    }

    const cookies = this.getCookies()
    if (cookies) {
      headers['Cookie'] = cookies
    } else {
      console.warn('[QwenAI] Warning: No cookies provided. This may cause Bad_Request error.')
      console.warn('[QwenAI] Required cookies: cnaui, aui, sca, xlly_s, cna, token, _bl_uid, x-ap')
    }

    return headers
  }

  mapModel(openaiModel: string): string {
    let model = openaiModel
    let forceThinking: boolean | undefined
    
    if (model.endsWith('-thinking')) {
      forceThinking = true
      model = model.slice(0, -9)
    } else if (model.endsWith('-fast')) {
      forceThinking = false
      model = model.slice(0, -5)
    }
    
    ;(this as any)._forceThinking = forceThinking
    
    const lowerModel = model.toLowerCase()
    
    if (MODEL_ALIASES[lowerModel]) {
      return MODEL_ALIASES[lowerModel]
    }
    
    if (this.provider.modelMappings) {
      for (const [key, value] of Object.entries(this.provider.modelMappings)) {
        if (key.toLowerCase() === lowerModel) {
          return value
        }
      }
    }
    
    return model
  }

  async createChat(
    modelId: string,
    title: string = 'New Chat',
    requestOptions: QwenAiRequestOptions = {},
  ): Promise<string> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/new`
    const payload = {
      title,
      models: [modelId],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    }

    try {
      const response = await this.axiosInstance.post(url, payload, {
        headers: this.getHeaders(),
        ...(requestOptions.timeoutMs !== undefined ? { timeout: requestOptions.timeoutMs } : {}),
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      })

      console.log('[QwenAI] Create chat response status:', response.status)

      if (response.data?.data?.id) {
        console.log('[QwenAI] Created chat:', response.data.data.id)
        return response.data.data.id
      }

      throw new Error('Failed to create chat: no chat ID returned')
    } catch (error) {
      console.error('[QwenAI] Failed to create chat:', error instanceof Error ? error.message : 'Unknown error')
      throw error
    }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/${chatId}`

    try {
      const response = await this.axiosInstance.delete(url, {
        headers: this.getHeaders(),
      })

      if (response.data?.success) {
        console.log('[QwenAI] Deleted chat:', chatId)
        return true
      }

      console.warn('[QwenAI] Failed to delete chat, status:', response.status)
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete chat:', error instanceof Error ? error.message : 'Unknown error')
      return false
    }
  }

  /**
   * Delete all chats for the current account
   * @returns Promise<boolean> - true if deletion was successful
   */
  async deleteAllChats(): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/`

    try {
      console.log('[QwenAI] Deleting all chats for account')
      
      const response = await this.axiosInstance.delete(url, {
        headers: this.getHeaders(),
      })

      if (response.data?.success) {
        console.log('[QwenAI] All chats deleted successfully')
        return true
      }

      console.warn('[QwenAI] Failed to delete all chats, status:', response.status)
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete all chats:', error instanceof Error ? error.message : 'Unknown error')
      return false
    }
  }

  async chatCompletion(
    request: ChatCompletionRequest,
    requestOptions: QwenAiRequestOptions = {},
  ): Promise<{
    response: AxiosResponse
    chatId: string
    parentId: string | null
  }> {
    const token = this.getToken()
    if (!token) {
      throw new Error('Qwen AI token not configured, please add token in account settings')
    }

    const modelId = this.mapModel(request.model)
    
    // Get forced thinking mode setting from originalModel (preserves user's intent before mapping)
    // If originalModel exists, use it for thinking detection; otherwise fall back to request.model
    const modelForThinking = request.originalModel || request.model
    const modelLower = modelForThinking.toLowerCase()
    let forceThinking: boolean | undefined
    if (modelForThinking.endsWith('-thinking')) {
      forceThinking = true
    } else if (modelForThinking.endsWith('-fast')) {
      forceThinking = false
    } else if (modelLower.includes('think') || modelLower.includes('r1')) {
      // Auto-enable thinking based on model name keywords (e.g. "Qwen3.6-Plus-AI-Think-Search")
      forceThinking = true
      console.log('[QwenAI] Thinking mode enabled (from model name keyword)')
    } else {
      // Use the forceThinking from mapModel if no originalModel-specific detection
      forceThinking = (this as any)._forceThinking
    }

    // Validate and resolve controls before creating a remote chat so malformed
    // client requests do not leave orphaned Qwen conversations behind.
    const generationSettings = resolveQwenAiGenerationSettings(request, forceThinking)

    // Always create a new chat (single-turn mode only)
    const chatId = await this.createChat(modelId, 'OpenAI_API_Chat', requestOptions)
    console.log('[QwenAI] Created new chat:', chatId)

    // The Qwen web endpoint accepts one user message. Preserve the complete
    // OpenAI conversation inside it, including assistant tool calls and tool
    // validation results needed for correction turns.
    const userContent = buildQwenAiPrompt(request.messages, request.toolProtocol)

    const fid = uuid()
    const childId = uuid()
    const ts = Math.floor(Date.now() / 1000)

    const featureConfig = buildQwenAiFeatureConfig(generationSettings)

    const payload: Record<string, any> = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: modelId,
      parent_id: null,
      messages: [
        {
          fid,
          parentId: null,
          childrenIds: [childId],
          role: 'user',
          content: userContent,
          user_action: 'chat',
          files: [],
          timestamp: ts,
          models: [modelId],
          chat_type: 't2t',
          feature_config: featureConfig,
          extra: { meta: { subChatType: 't2t' } },
          sub_chat_type: 't2t',
          parent_id: null,
        },
      ],
      timestamp: ts + 1,
      ...(generationSettings.maxTokens !== undefined && {
        max_tokens: generationSettings.maxTokens,
      }),
      ...(generationSettings.maxCompletionTokens !== undefined && {
        max_completion_tokens: generationSettings.maxCompletionTokens,
      }),
    }

    const url = `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${chatId}`

    console.log('[QwenAI] Sending request to /api/v2/chat/completions...')
    console.log('[QwenAI] Request metadata:', {
      model: modelId,
      promptLength: userContent.length,
      stream: true,
    })
    const requestHeaders = this.getHeaders(chatId)

    const response = await this.axiosInstance.post(url, payload, {
      headers: {
        ...requestHeaders,
        'x-accel-buffering': 'no',
      },
      responseType: 'stream',
      timeout: requestOptions.timeoutMs ?? 1800000,
      ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      validateStatus: () => true,
    })

    console.log('[QwenAI] Response status:', response.status)

    return {
      response,
      chatId,
      parentId: null,
    }
  }

  static isQwenAiProvider(provider: Provider): boolean {
    return provider.id === 'qwen-ai' || provider.apiEndpoint.includes('chat.qwen.ai')
  }
}

export class QwenAiStreamHandler {
  private chatId: string = ''
  private model: string
  private created: number
  private onEnd?: (chatId: string) => void
  private responseId: string = ''
  private content: string = ''
  private toolCallsSent: boolean = false
  private endNotified: boolean = false
  private usage: OpenAiUsage | null = null
  private outputLimits: QwenAiOutputLimits
  private answerFinished: boolean = false
  private doneSignalSeen: boolean = false
  private outputLimitReached: boolean = false
  private upstreamCandidateKeys: string[] = []
  private upstreamChoiceEvents: Array<{
    phase: string
    status: string
    content: string
  }> = []
  private responseCreatedChoiceOffsets: number[] = []
  private upstreamEventSummary = {
    eventCount: 0,
    responseCreatedCount: 0,
    responseCreatedChoiceOffsets: [] as number[],
    choiceEventCount: 0,
    maxChoicesPerEvent: 0,
    choiceIndices: [] as Array<string | number>,
    candidateCount: 0,
    candidateSequence: [] as string[],
    identityFields: [] as string[],
    phaseStatusPairs: [] as string[],
    deltaKeySets: [] as string[],
    contentChunkCount: 0,
    contentChars: 0,
  }

  constructor(
    model: string,
    onEnd?: (chatId: string) => void,
    outputLimits: QwenAiOutputLimits = {}
  ) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.outputLimits = outputLimits
  }

  setChatId(chatId: string) {
    this.chatId = chatId
  }

  getUpstreamEventSummary() {
    return {
      ...this.upstreamEventSummary,
      responseCreatedChoiceOffsets: [...this.upstreamEventSummary.responseCreatedChoiceOffsets],
      choiceIndices: [...this.upstreamEventSummary.choiceIndices],
      candidateSequence: [...this.upstreamEventSummary.candidateSequence],
      identityFields: [...this.upstreamEventSummary.identityFields],
      phaseStatusPairs: [...this.upstreamEventSummary.phaseStatusPairs],
      deltaKeySets: [...this.upstreamEventSummary.deltaKeySets],
    }
  }

  getUpstreamCompletionState(): QwenAiUpstreamCompletionState {
    if (this.outputLimitReached) return 'output_limit'
    if (this.answerFinished || this.doneSignalSeen) return 'complete'
    return 'incomplete'
  }

  getAlternativeAnswerContents(): string[] {
    const laneCount = Math.min(this.upstreamEventSummary.responseCreatedCount, 4)
    const isUnidentifiedMultiplex = this.hasUnidentifiedMultiplexedResponse()

    if (!isUnidentifiedMultiplex) return []

    const eventLanes = this.upstreamChoiceEvents.reduce(
      (contents, event, index) => {
        if (!['answer', 'final', 'none'].includes(event.phase) || !event.content) {
          return contents
        }
        const laneIndex = index % laneCount
        return contents.map((content, currentIndex) =>
          currentIndex === laneIndex ? content + event.content : content
        )
      },
      Array.from({ length: laneCount }, () => ''),
    )
    const answerChunks = this.upstreamChoiceEvents.filter((event) =>
      ['answer', 'final', 'none'].includes(event.phase) && event.content
    )
    const contentLanes = answerChunks.reduce(
      (contents, event, index) => {
        const laneIndex = index % laneCount
        return contents.map((content, currentIndex) =>
          currentIndex === laneIndex ? content + event.content : content
        )
      },
      Array.from({ length: laneCount }, () => ''),
    )
    const lanes = [...eventLanes, ...contentLanes]

    return lanes.filter((content, index) =>
      content.trim() && lanes.indexOf(content) === index
    )
  }

  hasUnidentifiedMultiplexedResponse(): boolean {
    const offsets = this.responseCreatedChoiceOffsets
    return this.upstreamEventSummary.responseCreatedCount > 1
      && this.upstreamEventSummary.candidateCount === 0
      && offsets.length === this.upstreamEventSummary.responseCreatedCount
      && offsets.every((offset) => offset === offsets[0])
  }

  private recordUpstreamEvent(data: any): void {
    const choices = Array.isArray(data?.choices) ? data.choices : []
    const choice = choices[0]
    const delta = choice?.delta && typeof choice.delta === 'object' ? choice.delta : {}
    const remember = <T>(values: T[], value: T, limit: number = 24): T[] =>
      values.includes(value) || values.length >= limit ? values : [...values, value]
    const identityEntries: Array<[string, unknown]> = [
      ['choice.index', choice?.index],
      ['choice.id', choice?.id],
      ['choice.message_id', choice?.message_id],
      ['delta.id', delta.id],
      ['delta.response_id', delta.response_id],
      ['delta.message_id', delta.message_id],
      ['delta.choice_id', delta.choice_id],
      ['delta.parent_id', delta.parent_id],
      ['delta.extra.response_id', delta.extra?.response_id],
      ['delta.extra.message_id', delta.extra?.message_id],
    ].filter((entry) => ['string', 'number'].includes(typeof entry[1]))
    const candidateKey = identityEntries
      .map(([field, value]) => `${field}:${String(value)}`)
      .join('|')
    let candidateKeys = this.upstreamCandidateKeys
    let candidateSequence = this.upstreamEventSummary.candidateSequence

    if (candidateKey) {
      const existingIndex = candidateKeys.indexOf(candidateKey)
      const candidateIndex = existingIndex >= 0 ? existingIndex : candidateKeys.length
      candidateKeys = existingIndex >= 0 ? candidateKeys : [...candidateKeys, candidateKey]
      candidateSequence = candidateSequence.length >= 80
        ? candidateSequence
        : [...candidateSequence, `candidate_${candidateIndex + 1}`]
    }

    const phase = typeof delta.phase === 'string' ? delta.phase : 'none'
    const status = typeof delta.status === 'string' ? delta.status : 'none'
    const deltaKeySet = Object.keys(delta).sort().join(',') || 'none'
    const contentLength = typeof delta.content === 'string' ? delta.content.length : 0
    const responseCreated = !!data?.['response.created']?.response_id
    const responseCreatedChoiceOffsets = responseCreated
      ? [...this.responseCreatedChoiceOffsets, this.upstreamChoiceEvents.length]
      : this.responseCreatedChoiceOffsets
    const upstreamChoiceEvents = choices.length > 0
      ? [...this.upstreamChoiceEvents, { phase, status, content: typeof delta.content === 'string' ? delta.content : '' }]
      : this.upstreamChoiceEvents

    this.upstreamCandidateKeys = candidateKeys
    this.responseCreatedChoiceOffsets = responseCreatedChoiceOffsets
    this.upstreamChoiceEvents = upstreamChoiceEvents
    this.upstreamEventSummary = {
      eventCount: this.upstreamEventSummary.eventCount + 1,
      responseCreatedCount: this.upstreamEventSummary.responseCreatedCount
        + (responseCreated ? 1 : 0),
      responseCreatedChoiceOffsets,
      choiceEventCount: this.upstreamEventSummary.choiceEventCount + (choices.length > 0 ? 1 : 0),
      maxChoicesPerEvent: Math.max(this.upstreamEventSummary.maxChoicesPerEvent, choices.length),
      choiceIndices: choice?.index !== undefined
        ? remember(this.upstreamEventSummary.choiceIndices, choice.index)
        : this.upstreamEventSummary.choiceIndices,
      candidateCount: candidateKeys.length,
      candidateSequence,
      identityFields: identityEntries.reduce(
        (fields, [field]) => remember(fields, field),
        this.upstreamEventSummary.identityFields,
      ),
      phaseStatusPairs: choices.length > 0
        ? remember(this.upstreamEventSummary.phaseStatusPairs, `${phase}:${status}`)
        : this.upstreamEventSummary.phaseStatusPairs,
      deltaKeySets: choices.length > 0
        ? remember(this.upstreamEventSummary.deltaKeySets, deltaKeySet)
        : this.upstreamEventSummary.deltaKeySets,
      contentChunkCount: this.upstreamEventSummary.contentChunkCount + (contentLength > 0 ? 1 : 0),
      contentChars: this.upstreamEventSummary.contentChars + contentLength,
    }
  }

  private notifyEnd(): void {
    if (this.endNotified || !this.onEnd || !this.chatId) return
    this.endNotified = true
    this.onEnd(this.chatId)
  }

  private sendToolCalls(transStream: PassThrough): void {
    if (this.toolCallsSent) return
    
    const toolCalls = parseToolUse(this.content)
    if (toolCalls && toolCalls.length > 0) {
      this.toolCallsSent = true
      
      // Send tool_calls delta
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        transStream.write(
          `data: ${JSON.stringify({
            id: this.responseId || this.chatId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i,
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                }],
              },
              finish_reason: null,
            }],
            created: this.created,
          })}\n\n`
        )
      }
      
      // Send finish with tool_calls
      transStream.write(
        `data: ${JSON.stringify({
          id: this.responseId || this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          ...(this.usage ? { usage: this.usage } : {}),
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      this.notifyEnd()
    }
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()

    console.log('[QwenAI] Starting stream handler...')

    let reasoningText = ''
    let hasSentReasoning = false
    let summaryText = ''
    let initialChunkSent = false
    let totalLimitReached = false
    let answerLimitReached = false
    let lastCompletionTokens = 0
    let answerTokenBaseline: number | undefined
    let terminal = false
    let readySettled = false
    let resolveReady!: (value: PassThrough) => void
    let rejectReady!: (reason: Error) => void

    const ready = new Promise<PassThrough>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    const markReady = () => {
      if (!readySettled) {
        readySettled = true
        resolveReady(transStream)
      }
    }

    const failStream = (error: Error) => {
      if (terminal) return
      terminal = true
      console.error('[QwenAI] Stream failed:', error.message)
      this.notifyEnd()

      if (!readySettled) {
        readySettled = true
        transStream.destroy()
        rejectReady(error)
        return
      }

      queueMicrotask(() => transStream.destroy(error))
    }

    const finishStream = (finishReason: string = 'stop') => {
      if (terminal) return

      if (!this.content.trim()) {
        failStream(new Error(EMPTY_RESPONSE_ERROR))
        return
      }

      terminal = true
      markReady()

      if (hasToolUse(this.content)) {
        console.log('[QwenAI] Found tool_use in stream, sending tool_calls')
        this.sendToolCalls(transStream)
        return
      }

      const finalChunk = {
        id: this.responseId || this.chatId,
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        ...(this.usage ? { usage: this.usage } : {}),
        created: this.created,
      }
      transStream.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
      transStream.end('data: [DONE]\n\n')
      this.notifyEnd()
    }

    const sendInitialChunk = () => {
      if (!initialChunkSent) {
        const initialChunk = `data: ${JSON.stringify({
          id: '',
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          created: this.created,
        })}\n\n`
        transStream.write(initialChunk)
        initialChunkSent = true
        console.log('[QwenAI] Initial chunk written')
      }
    }

    const parser = createParser({
      onEvent: (event: any) => {
        if (terminal) return

        try {
          if (event.data === '[DONE]') {
            console.log('[QwenAI] Received [DONE] signal')
            this.doneSignalSeen = true
            finishStream()
            return
          }

          const data = JSON.parse(event.data)
          this.recordUpstreamEvent(data)
          console.log('[QwenAI] Parsed JSON data keys:', Object.keys(data))

          const upstreamError = getUpstreamError(data)
          if (upstreamError) {
            failStream(createUpstreamError(upstreamError))
            return
          }

          const previousCompletionTokens = lastCompletionTokens
          const normalizedUsage = normalizeUsage(data.usage)
          if (normalizedUsage) {
            this.usage = normalizedUsage
            lastCompletionTokens = normalizedUsage.completion_tokens
            console.log('[QwenAI] Upstream usage:', normalizedUsage)
            if (
              this.outputLimits.maxCompletionTokens !== undefined
              && normalizedUsage.completion_tokens >= this.outputLimits.maxCompletionTokens
            ) {
              totalLimitReached = true
            }
          }

          if (data['response.created']?.response_id) {
            const nextResponseId = data['response.created'].response_id
            const responseRestarted = !!this.responseId && this.responseId !== nextResponseId
            if (responseRestarted) {
              console.warn('[QwenAI] Upstream response restarted; discarding superseded partial output')
              this.content = ''
              this.usage = null
              reasoningText = ''
              summaryText = ''
              totalLimitReached = false
              answerLimitReached = false
              lastCompletionTokens = 0
              answerTokenBaseline = undefined
              this.answerFinished = false
              this.doneSignalSeen = false
              this.outputLimitReached = false
            }
            this.responseId = nextResponseId
            console.log('[QwenAI] Got response_id:', this.responseId)
          }

          if (data.choices && data.choices.length > 0) {
            const choice = data.choices[0]
            const delta = choice.delta || {}
            const phase = delta.phase
            const status = delta.status
            const content = typeof delta.content === 'string' ? delta.content : ''

            console.log('[QwenAI] Phase:', phase, 'Status:', status, 'Content length:', content.length)

            if (phase === 'think') {
              if (!totalLimitReached && status !== 'finished' && content) {
                // Stream thinking content as reasoning_content in real-time
                reasoningText += content
                if (!hasSentReasoning) {
                  transStream.write(
                    `data: ${JSON.stringify({
                      id: this.responseId || this.chatId,
                      model: this.model,
                      object: 'chat.completion.chunk',
                      choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
                      created: this.created,
                    })}\n\n`
                  )
                  hasSentReasoning = true
                  console.log('[QwenAI] Sent reasoning role chunk')
                }
                if (content) {
                  transStream.write(
                    `data: ${JSON.stringify({
                      id: this.responseId || this.chatId,
                      model: this.model,
                      object: 'chat.completion.chunk',
                      choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
                      created: this.created,
                    })}\n\n`
                  )
                }
                markReady()
              }
              // When status === 'finished', the think phase is done
            } else if (phase === 'thinking_summary') {
              const extra = delta.extra || {}
              console.log('[QwenAI] thinking_summary extra:', JSON.stringify(extra).substring(0, 300))
              if (!totalLimitReached && extra.summary_thought?.content) {
                const newSummary = extra.summary_thought.content.join('\n')
                if (newSummary && newSummary.length > summaryText.length) {
                  // Send only the incremental diff as reasoning_content
                  const diff = newSummary.substring(summaryText.length)
                  if (diff) {
                    if (!hasSentReasoning) {
                      transStream.write(
                        `data: ${JSON.stringify({
                          id: this.responseId || this.chatId,
                          model: this.model,
                          object: 'chat.completion.chunk',
                          choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
                          created: this.created,
                        })}\n\n`
                      )
                      hasSentReasoning = true
                    }
                    transStream.write(
                      `data: ${JSON.stringify({
                        id: this.responseId || this.chatId,
                        model: this.model,
                        object: 'chat.completion.chunk',
                        choices: [{ index: 0, delta: { reasoning_content: diff }, finish_reason: null }],
                        created: this.created,
                      })}\n\n`
                    )
                    markReady()
                  }
                  summaryText = newSummary
                  console.log('[QwenAI] Updated summaryText, length:', summaryText.length)
                }
              }
            } else if (phase === 'answer' || phase === 'final' || phase == null) {
              if (answerTokenBaseline === undefined) {
                answerTokenBaseline = previousCompletionTokens
              }

              if (
                this.outputLimits.maxTokens !== undefined
                && lastCompletionTokens - answerTokenBaseline >= this.outputLimits.maxTokens
              ) {
                answerLimitReached = true
              }

              if (content && !initialChunkSent) {
                sendInitialChunk()
              }

              // Accumulate content for tool call detection
              this.content += content

              if (content) {
                const chunk = {
                  id: this.responseId || this.chatId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { content }, finish_reason: null }],
                  created: this.created,
                }
                transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
                markReady()
              }
            }

            if (
              !terminal
              && (totalLimitReached || answerLimitReached)
              && this.content.trim()
            ) {
              this.outputLimitReached = true
              console.log('[QwenAI] Output limit reached; stopping upstream stream')
              finishStream('length')
              if (typeof stream.destroy === 'function' && !stream.destroyed) {
                stream.destroy()
              }
              return
            }

            if (
              ['finished', 'completed', 'done'].includes(status) &&
              (phase === 'answer' || phase === 'final' || phase == null)
            ) {
              const finishReason = delta.finish_reason || choice.finish_reason || 'stop'
              this.answerFinished = true
              if (finishReason === 'length') this.outputLimitReached = true
              finishStream(finishReason)
            }
          }

          if (
            !terminal
            && (totalLimitReached || answerLimitReached)
            && this.content.trim()
          ) {
            this.outputLimitReached = true
            console.log('[QwenAI] Output limit reached on usage event; stopping upstream stream')
            finishStream('length')
            if (typeof stream.destroy === 'function' && !stream.destroyed) {
              stream.destroy()
            }
          }
        } catch (err) {
          console.error('[QwenAI] Stream parse error:', err)
          failStream(err instanceof Error ? err : new Error(String(err)))
        }
      },
    })

    stream.on('data', (buffer: Buffer) => {
      console.log('[QwenAI] Raw stream chunk bytes:', buffer.length)
      parser.feed(buffer.toString())
    })
    stream.once('error', (err: Error) => {
      console.error('[QwenAI] Stream error:', err)
      failStream(err)
    })

    const handleTransportEnd = () => {
      if (terminal) return
      console.log('[QwenAI] Upstream stream ended')
      finishStream()
    }
    stream.once('end', handleTransportEnd)
    stream.once('close', handleTransportEnd)

    transStream.once('close', () => {
      if (terminal) return
      terminal = true
      if (typeof stream.destroy === 'function' && !stream.destroyed) {
        stream.destroy()
      }
      this.notifyEnd()
    })

    return ready
  }

  async handleNonStream(stream: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const data: any = {
        id: '',
        model: this.model,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '', reasoning_content: '' },
            finish_reason: 'stop',
          },
        ],
        created: this.created,
      }

      let reasoningText = ''
      let summaryText = ''
      let totalLimitReached = false
      let answerLimitReached = false
      let lastCompletionTokens = 0
      let answerTokenBaseline: number | undefined
      let resolved = false

      const resolveOnce = (value: any) => {
        if (!resolved) {
          resolved = true
          resolve(value)
        }
      }

      const rejectOnce = (reason: any) => {
        if (!resolved) {
          resolved = true
          this.notifyEnd()
          reject(reason)
        }
      }

      const finish = () => {
        if (resolved) return

        const finalReasoning = reasoningText || summaryText
        if (finalReasoning) {
          data.choices[0].message.reasoning_content = finalReasoning
        }

        if (!data.choices[0].message.content.trim()) {
          rejectOnce(new Error(EMPTY_RESPONSE_ERROR))
          return
        }

        this.notifyEnd()
        resolveOnce(data)
      }

      const parser = createParser({
        onEvent: (event: any) => {
          if (resolved) return

          try {
            if (event.data === '[DONE]') {
              this.doneSignalSeen = true
              finish()
              return
            }

            const parsed = JSON.parse(event.data)
            this.recordUpstreamEvent(parsed)

            const upstreamError = getUpstreamError(parsed)
            if (upstreamError) {
              rejectOnce(createUpstreamError(upstreamError))
              return
            }

            const previousCompletionTokens = lastCompletionTokens
            const normalizedUsage = normalizeUsage(parsed.usage)
            if (normalizedUsage) {
              this.usage = normalizedUsage
              data.usage = { ...normalizedUsage }
              lastCompletionTokens = normalizedUsage.completion_tokens
              console.log('[QwenAI] Upstream usage:', normalizedUsage)
              if (
                this.outputLimits.maxCompletionTokens !== undefined
                && normalizedUsage.completion_tokens >= this.outputLimits.maxCompletionTokens
              ) {
                totalLimitReached = true
              }
            }

            if (parsed['response.created']?.response_id) {
              const nextResponseId = parsed['response.created'].response_id
              const responseRestarted = !!this.responseId && this.responseId !== nextResponseId
              if (responseRestarted) {
                console.warn('[QwenAI] Upstream response restarted; discarding superseded partial output')
                data.choices[0].message.content = ''
                data.choices[0].message.reasoning_content = ''
                data.choices[0].finish_reason = 'stop'
                delete data.usage
                this.usage = null
                reasoningText = ''
                summaryText = ''
                totalLimitReached = false
                answerLimitReached = false
                lastCompletionTokens = 0
                answerTokenBaseline = undefined
                this.answerFinished = false
                this.doneSignalSeen = false
                this.outputLimitReached = false
              }
              this.responseId = nextResponseId
              data.id = this.responseId
            }

            if (parsed.choices && parsed.choices.length > 0) {
              const delta = parsed.choices[0].delta || {}
              const phase = delta.phase
              const status = delta.status
              const content = typeof delta.content === 'string' ? delta.content : ''

              if (phase === 'think' && !totalLimitReached && status !== 'finished') {
                reasoningText += content
              } else if (phase === 'thinking_summary') {
                // Handle thinking_summary phase - extract summary content
                const extra = delta.extra || {}
                if (!totalLimitReached && extra.summary_thought?.content) {
                  const newSummary = extra.summary_thought.content.join('\n')
                  if (newSummary && newSummary.length > summaryText.length) {
                    summaryText = newSummary
                  }
                }
              } else if (phase === 'answer' || phase === 'final' || phase == null) {
                if (answerTokenBaseline === undefined) {
                  answerTokenBaseline = previousCompletionTokens
                }

                if (
                  this.outputLimits.maxTokens !== undefined
                  && lastCompletionTokens - answerTokenBaseline >= this.outputLimits.maxTokens
                ) {
                  answerLimitReached = true
                }

                if (content) {
                  data.choices[0].message.content += content
                }
                if (
                  (totalLimitReached || answerLimitReached)
                  && data.choices[0].message.content.trim()
                ) {
                  this.outputLimitReached = true
                  data.choices[0].finish_reason = 'length'
                  console.log('[QwenAI] Output limit reached; stopping upstream stream')
                  finish()
                  if (typeof stream.destroy === 'function' && !stream.destroyed) {
                    stream.destroy()
                  }
                  return
                }
                if (['finished', 'completed', 'done'].includes(status)) {
                  const finishReason = delta.finish_reason || parsed.choices[0].finish_reason || 'stop'
                  this.answerFinished = true
                  if (finishReason === 'length') this.outputLimitReached = true
                  data.choices[0].finish_reason = finishReason
                  finish()
                }
              }
            }

            if (
              !resolved
              && (totalLimitReached || answerLimitReached)
              && data.choices[0].message.content.trim()
            ) {
              this.outputLimitReached = true
              data.choices[0].finish_reason = 'length'
              console.log('[QwenAI] Output limit reached on usage event; stopping upstream stream')
              finish()
              if (typeof stream.destroy === 'function' && !stream.destroyed) {
                stream.destroy()
              }
            }
          } catch (err) {
            console.error('[QwenAI] Non-stream parse error:', err)
            rejectOnce(err)
          }
        },
      })

      stream.on('data', (buffer: Buffer) => parser.feed(buffer.toString()))
      stream.once('error', (err: Error) => {
        console.error('[QwenAI] Non-stream error:', err)
        rejectOnce(err)
      })
      stream.once('end', finish)
      stream.once('close', finish)
    })
  }

  getChatId(): string {
    return this.chatId
  }

  getResponseId(): string {
    return this.responseId
  }
}

export const qwenAiAdapter = {
  QwenAiAdapter,
  QwenAiStreamHandler,
}
