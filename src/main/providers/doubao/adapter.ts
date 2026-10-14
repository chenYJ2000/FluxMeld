/**
 * Doubao (豆包) web adapter.
 *
 * Implements the `samantha` chat protocol used by www.doubao.com: a browser
 * session (cookie + identifiers) authenticates a single-shot completion that
 * streams Server-Sent Events. The OpenAI chat is flattened into one prompt
 * message; the reference implementation lives in the DoubaoFreeApi project.
 */

import axios, { type AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import type { Account, Provider } from '../../store/types'
import { uuid } from '../common/crypto'
import { getAbortReason, RequestTimeoutError, throwIfAborted } from '../../proxy/requestLifecycle'

const DOUBAO_API_BASE = 'https://www.doubao.com'
const CHAT_PATH = '/samantha/chat/completion'
const DELETE_PATH = '/samantha/thread/delete'
const PC_VERSION = '2.23.2'
const VERSION_CODE = '20800'
const DEFAULT_TIMEOUT_MS = 1800000

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0'

const TEXT_CONTENT_TYPES = new Set([10000, 2001, 2008])
const IMAGE_CONTENT_TYPE = 2074

const REQUIRED_CREDENTIALS = ['cookies', 'device_id', 'tea_uuid', 'web_id', 'x_flow_trace'] as const

export interface DoubaoRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
  requestId?: string
}

interface DoubaoMessage {
  role: string
  content: unknown
}

interface DoubaoChatRequest {
  model: string
  originalModel?: string
  messages: DoubaoMessage[]
  stream?: boolean
  useDeepThink?: boolean
  useAutoCot?: boolean
}

export class DoubaoUpstreamError extends Error {
  readonly status = 502

  constructor(message: string) {
    super(message)
    this.name = 'DoubaoUpstreamError'
  }
}

/** The guest session hit Doubao's 5-conversation anonymous limit. */
export class DoubaoLimitedError extends Error {
  readonly status = 429

  constructor() {
    super('Doubao 游客会话次数已用完，请使用已登录账号的 Cookie')
    this.name = 'DoubaoLimitedError'
  }
}

function getDoubaoRequestTimeout(defaultMs: number, options?: DoubaoRequestOptions): number {
  const requested = options?.timeoutMs
  return requested === undefined || !Number.isFinite(requested)
    ? defaultMs
    : Math.max(1, Math.min(defaultMs, requested))
}

/** Read a short snippet from a stream/response body for diagnostics. */
export async function readStreamSnippet(data: any, maxBytes = 2000): Promise<string> {
  if (!data) return ''
  if (typeof data === 'string') return data.slice(0, maxBytes)
  if (typeof data.read !== 'function') {
    try {
      return JSON.stringify(data).slice(0, maxBytes)
    } catch {
      return ''
    }
  }
  return await new Promise((resolve) => {
    let out = ''
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve(out.slice(0, maxBytes))
    }
    data.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      if (out.length >= maxBytes) {
        try {
          data.destroy()
        } catch {
          /* noop */
        }
        finish()
      }
    })
    data.on('end', finish)
    data.on('error', finish)
    setTimeout(() => {
      try {
        data.destroy()
      } catch {
        /* noop */
      }
      finish()
    }, 1500)
  })
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (part?.type === 'text' && typeof part.text === 'string') return part.text
        if (part?.type === 'image_url' && part.image_url?.url) {
          return `![image](${part.image_url.url})`
        }
        return ''
      })
      .join('')
  }
  return ''
}

function roleLabel(role: string): string {
  if (role === 'system') return 'System'
  if (role === 'assistant') return 'Assistant'
  return 'User'
}

export class DoubaoAdapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private credential(name: string): string {
    return String(this.account.credentials?.[name] ?? '').trim()
  }

  static missingCredentials(credentials: Record<string, string> | undefined): string[] {
    return REQUIRED_CREDENTIALS.filter((key) => !String(credentials?.[key] ?? '').trim())
  }

  private buildQueryParams(includeWebId: boolean): string {
    const parts = [
      'aid=497858',
      `device_id=${this.credential('device_id')}`,
      'device_platform=web',
      'language=zh',
      `pc_version=${PC_VERSION}`,
      'pkg_type=release_version',
      'real_aid=497858',
      'region=CN',
      'samantha_web=1',
      'sys_region=CN',
      `tea_uuid=${this.credential('tea_uuid')}`,
      'use-olympus-account=1',
      `version_code=${VERSION_CODE}`,
    ]
    if (includeWebId) parts.push(`web_id=${this.credential('web_id')}`)
    return parts.join('&')
  }

  private buildHeaders(): Record<string, string> {
    const roomId = this.credential('room_id')
    return {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'agw-js-conv': 'str',
      cookie: this.credential('cookies'),
      origin: DOUBAO_API_BASE,
      referer: `${DOUBAO_API_BASE}/chat/${roomId}`,
      'user-agent': USER_AGENT,
      'x-flow-trace': this.credential('x_flow_trace'),
    }
  }

  /** Flatten the OpenAI conversation into Doubao's single-prompt message. */
  private messagesToPrompt(messages: DoubaoMessage[]): string {
    const lines = messages.map((message) => ({
      role: message.role,
      text: extractText(message.content),
    }))

    if (lines.length <= 1) return lines[0]?.text ?? ''

    return (
      lines.map((line) => `${roleLabel(line.role)}: ${line.text}`).join('\n\n') + '\n\nAssistant: '
    )
  }

  private buildBody(request: DoubaoChatRequest): Record<string, unknown> {
    const cookies = this.credential('cookies')
    const useDeepThink = request.useDeepThink ?? false
    const useAutoCot = request.useAutoCot ?? false

    const body: Record<string, unknown> = {
      completion_option: {
        is_regen: false,
        with_suggest: false,
        need_create_conversation: true,
        launch_stage: 1,
        use_auto_cot: useDeepThink ? false : useAutoCot,
        use_deep_think: useDeepThink,
      },
      conversation_id: '0',
      messages: [
        {
          content: JSON.stringify({ text: this.messagesToPrompt(request.messages) }),
          content_type: 2001,
          attachments: [],
          references: [],
        },
      ],
    }

    // Logged-in sessions must send the local ids so Doubao can echo them back.
    if (cookies) {
      body.local_conversation_id = `local_${Math.floor(Math.random() * 1e16)}`
      body.local_message_id = uuid()
    }

    return body
  }

  async chatCompletion(
    request: DoubaoChatRequest,
    options?: DoubaoRequestOptions,
  ): Promise<AxiosResponse> {
    throwIfAborted(options?.signal)
    const url = `${DOUBAO_API_BASE}${CHAT_PATH}?${this.buildQueryParams(true)}`
    const response = await axios.post(url, this.buildBody(request), {
      headers: this.buildHeaders(),
      timeout: getDoubaoRequestTimeout(DEFAULT_TIMEOUT_MS, options),
      signal: options?.signal,
      validateStatus: () => true,
      responseType: 'stream',
    })

    if (response.status >= 400) {
      const snippet = await readStreamSnippet(response.data)
      console.error(
        `[Doubao-DIAG] chat HTTP ${response.status} account=${this.account.name} body=${snippet}`,
      )
    }

    return response
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      const url = `${DOUBAO_API_BASE}${DELETE_PATH}?${this.buildQueryParams(true)}`
      const response = await axios.post(
        url,
        { conversation_id: conversationId },
        {
          headers: {
            ...this.buildHeaders(),
            accept: 'application/json',
            referer: `${DOUBAO_API_BASE}/chat/${conversationId}`,
          },
          timeout: 30000,
          validateStatus: () => true,
        },
      )
      return response.status === 200
    } catch (error) {
      console.error('[Doubao] Failed to delete conversation:', error)
      return false
    }
  }

  static isDoubaoProvider(provider: Provider): boolean {
    return provider.id === 'doubao' || provider.apiEndpoint.includes('doubao.com')
  }
}

interface DoubaoStreamResult {
  conversationId: string
  messageId: string
  sectionId: string
  text: string
  images: string[]
}

/**
 * Translates the Doubao `samantha` SSE stream into OpenAI chunks.
 *
 * Streams carry `{ event_type, event_data }` payloads: 2002 = stream start
 * (conversation/message/section ids), 2001 = a message fragment, 2003 = end.
 */
export class DoubaoStreamHandler {
  private model: string
  private created: number
  private id = ''
  private conversationId = ''
  private messageId = ''
  private sectionId = ''
  private sentText = ''
  private imageUrls: string[] = []

  constructor(model: string) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
  }

  private accumulateText(text: string, onDelta?: (delta: string) => void): void {
    if (!text || text === this.sentText) return
    let delta: string
    // Handle both incremental fragments and cumulative snapshots.
    if (this.sentText && text.length > this.sentText.length && text.startsWith(this.sentText)) {
      delta = text.slice(this.sentText.length)
      this.sentText = text
    } else {
      delta = text
      this.sentText += text
    }
    if (delta) onDelta?.(delta)
  }

  private handleMessage(
    message: any,
    onDelta?: (delta: string) => void,
    onImage?: (url: string) => void,
  ): void {
    if (!message || typeof message !== 'object') return

    let parsed: any = {}
    if (typeof message.content === 'string') {
      try {
        parsed = JSON.parse(message.content)
      } catch {
        parsed = {}
      }
    } else if (message.content && typeof message.content === 'object') {
      parsed = message.content
    }

    const contentType = message.content_type

    if (TEXT_CONTENT_TYPES.has(contentType)) {
      const text = typeof parsed?.text === 'string' ? parsed.text : ''
      if (text) this.accumulateText(text, onDelta)
      return
    }

    if (contentType === IMAGE_CONTENT_TYPE) {
      const creations = Array.isArray(parsed?.creations) ? parsed.creations : []
      for (const creation of creations) {
        const image = creation?.image
        if (image?.status !== 2) continue
        const url =
          image?.image_raw?.url || image?.image_thumb?.url || image?.image_ori?.url || undefined
        if (url && !this.imageUrls.includes(url)) {
          this.imageUrls.push(url)
          onImage?.(url)
        }
      }
    }
  }

  private handleEvent(
    event: { event?: string; data?: string },
    finish: () => void,
    fail: (error: Error) => void,
    onDelta?: (delta: string) => void,
    onImage?: (url: string) => void,
  ): void {
    const name = event.event
    const data = event.data ?? ''

    if (name === 'gateway-error' || data.includes('gateway-error')) {
      let detail = data
      try {
        const parsed = JSON.parse(data)
        if (parsed?.code || parsed?.message) {
          detail = `${parsed.code ?? ''} ${parsed.message ?? ''}`.trim()
        }
      } catch {
        /* keep raw */
      }
      fail(new DoubaoUpstreamError(`Doubao 网关错误: ${detail.slice(0, 300) || 'unknown'}`))
      return
    }

    if (
      data.includes('tourist conversation reach limited') ||
      (typeof name === 'string' && name.includes('tourist conversation reach limited'))
    ) {
      fail(new DoubaoLimitedError())
      return
    }

    let payload: any
    try {
      payload = JSON.parse(data)
    } catch {
      return
    }

    let eventData: any = payload?.event_data
    if (typeof eventData === 'string') {
      try {
        eventData = JSON.parse(eventData)
      } catch {
        eventData = {}
      }
    }
    if (!eventData || typeof eventData !== 'object') eventData = {}

    const eventType = payload?.event_type
    if (eventType === 2002) {
      this.conversationId = eventData.conversation_id || this.conversationId
      this.messageId = eventData.message_id || this.messageId
      this.sectionId = eventData.section_id || this.sectionId
      if (this.conversationId) this.id = this.conversationId
    } else if (eventType === 2001) {
      this.handleMessage(eventData.message, onDelta, onImage)
    } else if (eventType === 2003) {
      finish()
    }
  }

  private consume(
    stream: any,
    onDelta?: (delta: string) => void,
    onImage?: (url: string) => void,
    options?: DoubaoRequestOptions,
  ): Promise<DoubaoStreamResult> {
    return new Promise((resolve, reject) => {
      let settled = false
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined = undefined
      const decoder = new TextDecoder('utf-8')

      const cleanup = (): void => {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        options?.signal?.removeEventListener('abort', onAbort)
        stream.off?.('data', onData)
        stream.off?.('error', onError)
        stream.off?.('end', onTransportEnd)
        stream.off?.('close', onTransportEnd)
      }

      const finish = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve({
          conversationId: this.conversationId,
          messageId: this.messageId,
          sectionId: this.sectionId,
          text: this.sentText,
          images: [...this.imageUrls],
        })
      }

      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        try {
          if (typeof stream.destroy === 'function' && !stream.destroyed) stream.destroy()
        } catch {
          /* noop */
        }
        reject(error)
      }

      const onData = (buffer: Buffer | string): void =>
        parser.feed(typeof buffer === 'string' ? buffer : decoder.decode(buffer, { stream: true }))
      const onError = (error: Error): void =>
        fail(new DoubaoUpstreamError(`Doubao 上游流错误: ${error.message}`))
      const onTransportEnd = (): void => {
        // End without an explicit 2003: accept whatever was streamed, else fail.
        if (this.sentText || this.imageUrls.length) finish()
        else fail(new DoubaoUpstreamError('Doubao 上游响应在完成前结束'))
      }
      const onAbort = (): void => {
        if (options?.signal) fail(getAbortReason(options.signal))
      }

      const parser = createParser({
        onEvent: (event: any) => {
          try {
            this.handleEvent(event, finish, fail, onDelta, onImage)
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)))
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

      const timeoutMs = getDoubaoRequestTimeout(DEFAULT_TIMEOUT_MS, options)
      timeoutHandle = setTimeout(
        () =>
          fail(
            new RequestTimeoutError(
              options?.requestId ?? 'unknown',
              timeoutMs,
              'Doubao upstream response',
            ),
          ),
        timeoutMs,
      )

      stream.on('data', onData)
    })
  }

  private imageMarkdown(): string {
    return this.imageUrls.map((url) => `![image](${url})`).join('\n')
  }

  async handleStream(stream: any, options?: DoubaoRequestOptions): Promise<PassThrough> {
    const transStream = new PassThrough()
    let completed = false

    const writeChunk = (delta: Record<string, unknown>, finishReason: string | null): void => {
      transStream.write(
        `data: ${JSON.stringify({
          id: this.id,
          model: this.model,
          object: 'chat.completion.chunk',
          created: this.created,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      )
    }

    writeChunk({ role: 'assistant', content: '' }, null)

    this.consume(stream, (delta) => writeChunk({ content: delta }, null), undefined, options)
      .then(() => {
        if (completed) return
        completed = true
        const images = this.imageMarkdown()
        if (images) writeChunk({ content: `\n${images}\n` }, null)
        writeChunk({}, 'stop')
        transStream.end('data: [DONE]\n\n')
      })
      .catch((error: unknown) => {
        if (completed) return
        completed = true
        transStream.destroy(error instanceof Error ? error : new Error(String(error)))
      })

    return transStream
  }

  async handleNonStream(stream: any, options?: DoubaoRequestOptions): Promise<any> {
    await this.consume(stream, undefined, undefined, options)
    const images = this.imageMarkdown()
    const content = (this.sentText + (images ? `\n${images}` : '')).replace(/^\n+|\n+$/g, '')

    return {
      id: this.id || `chatcmpl-doubao-${uuid()}`,
      model: this.model,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
    }
  }

  getConversationId(): string {
    return this.conversationId
  }
}
