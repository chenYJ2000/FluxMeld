/**
 * Proxy Service Module - Request Forwarder
 * Forwards requests to corresponding API based on provider configuration
 */

import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios'
import http2 from 'http2'
import { PassThrough } from 'stream'
import { Account, Provider } from '../store/types'
import { AccountSelection, ForwardResult, ChatCompletionRequest, ProxyContext } from './types'
import { proxyStatusManager } from './status'
import { outboundProxyManager } from './outboundProxy'
import { loadBalancer } from './loadbalancer'
import { storeManager } from '../store/store'
import {
  createProviderForwarders,
  createForwardFailure,
  type ForwarderServices,
  type ProviderForwarder,
} from './forwarders'
import {
  isToolCallingResponseErrorMessage,
  ToolCallingEngine,
  ToolCallingResponseError,
} from './toolCalling/ToolCallingEngine'
import type { ToolCallingTransformResult } from './toolCalling/types'
import {
  createToolRepairLogData,
  createToolRepairRequest,
  createToolRepairTelemetry,
  enforceSingleToolRepairResult,
  mergeOriginalReasoningIntoRepairResponse,
  shouldAttemptToolRepair,
} from './toolCalling/repair'
import { isReasoningEnabled } from './utils/reasoning'
import { sessionManager } from './sessionManager'
import {
  createContextManagementService,
  formatMessageForSummary,
  SummaryGenerator,
} from './services/contextManagementService'
import { cloneChatMessage } from './services/sessionContextService'
import type { ChatMessage as ContextChatMessage } from './types'
import { getAbortReason, getRemainingTimeout, throwIfAborted } from './requestLifecycle'

function shouldDeleteSession(): boolean {
  return sessionManager.shouldDeleteAfterChat()
}

function getForwardErrorMessageStatus(message?: string): number | undefined {
  if (!message) return undefined
  if (isToolCallingResponseErrorMessage(message)) return 502

  const match = /(?:HTTP|status(?: code)?)\s*[:=]?\s*([45]\d\d)/i.exec(message)
  return match ? Number(match[1]) : undefined
}

function isRetryableStatus(status: number | undefined, error?: string): boolean {
  if (isToolCallingResponseErrorMessage(error)) return false
  return (
    status === undefined ||
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  )
}

/**
 * Whether the failure signals that the direct connection IP was rate-limited,
 * blocked, or had transport-level problems �?conditions where routing the
 * reattempt through an outbound proxy is worth trying. Authentication failures
 * (401) are excluded because they are credential problems, not IP problems.
 */
export function shouldRouteThroughProxy(status: number | undefined, error?: string): boolean {
  if (isToolCallingResponseErrorMessage(error)) return false
  if (status === undefined) return true
  return (
    status === 403 ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  )
}

export function shouldMarkAccountFailed(
  status: number | undefined,
  error?: string,
  toolCallingFailure?: ForwardResult['toolCallingFailure'],
): boolean {
  if (
    toolCallingFailure?.code === 'upstream_multiplexed_response' ||
    toolCallingFailure?.code === 'upstream_incomplete_response'
  )
    return false
  if (isToolCallingResponseErrorMessage(error)) return false
  return (
    status === undefined ||
    status === 401 ||
    status === 403 ||
    status === 429 ||
    (status !== undefined && status >= 500)
  )
}

function recordAccountFailure(selection: AccountSelection, status: number | undefined): void {
  loadBalancer.markAccountFailed(selection.account.id)

  if (status !== 401 && status !== 403) return

  const checkedAt = Date.now()
  storeManager.updateAccount(selection.account.id, {
    status: 'error',
    errorMessage: `Authentication failed (HTTP ${status})`,
    lastStatusCheck: checkedAt,
  })
  storeManager.addLog('error', 'Account disabled after an authentication failure', {
    providerId: selection.provider.id,
    accountId: selection.account.id,
    data: { status },
  })
}

/**
 * Request Forwarder
 */
export class RequestForwarder {
  private axiosInstance = axios.create({
    timeout: 1800000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  private readonly providerForwarders: ProviderForwarder[] = createProviderForwarders(
    this.createForwarderServices(),
  )

  private createForwarderServices(): ForwarderServices {
    return {
      transformRequestForPromptToolUse: (request, provider) =>
        this.transformRequestForPromptToolUse(request, provider),
      applyToolCallsToResponse: (result, transformed) =>
        this.applyToolCallsToResponse(result, transformed),
      createBufferedResponseStream: (result, model) =>
        this.createBufferedResponseStream(result, model),
      extractHeaders: (headers) => this.extractHeaders(headers),
      shouldDeleteSession,
    }
  }

  /**
   * Transform request for prompt-based tool calling
   * For models that don't support native function calling
   * Delegates tool normalization, prompt injection, and parser planning to ToolCallingEngine.
   */
  private transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider,
  ): ToolCallingTransformResult {
    const config = storeManager.getConfig().toolCallingConfig
    const engine = new ToolCallingEngine(config)

    return engine.transformRequest({
      request,
      provider: provider ?? {
        id: 'custom',
        name: 'Custom',
        type: 'custom',
        authType: 'token',
        apiEndpoint: '',
        headers: {},
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
      actualModel: request.model,
    })
  }

  private applyToolCallsToResponse(result: any, transformed: ToolCallingTransformResult): void {
    const engine = new ToolCallingEngine(storeManager.getConfig().toolCallingConfig)
    engine.applyNonStreamResponse(result, transformed.plan)
  }

  private createBufferedResponseStream(result: any, model: string): PassThrough {
    const stream = new PassThrough()
    const choice = result?.choices?.[0] ?? {}
    const message = choice.message ?? {}
    const responseId = result?.id || `chatcmpl-${Date.now().toString(36)}`
    const created = result?.created || Math.floor(Date.now() / 1000)
    const baseChunk = {
      id: responseId,
      model,
      object: 'chat.completion.chunk',
      created,
    }

    queueMicrotask(() => {
      stream.write(
        `data: ${JSON.stringify({
          ...baseChunk,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        })}\n\n`,
      )

      if (message.reasoning_content) {
        stream.write(
          `data: ${JSON.stringify({
            ...baseChunk,
            choices: [
              {
                index: 0,
                delta: { reasoning_content: message.reasoning_content },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        )
      }

      if (message.content) {
        stream.write(
          `data: ${JSON.stringify({
            ...baseChunk,
            choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }],
          })}\n\n`,
        )
      }

      for (const [index, toolCall] of (message.tool_calls ?? []).entries()) {
        const { rawText, ...publicToolCall } = toolCall
        void rawText
        stream.write(
          `data: ${JSON.stringify({
            ...baseChunk,
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ ...publicToolCall, index }] },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        )
      }

      stream.write(
        `data: ${JSON.stringify({
          ...baseChunk,
          choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }],
          ...(result?.usage && { usage: result.usage }),
        })}\n\n`,
      )
      stream.end('data: [DONE]\n\n')
    })

    return stream
  }

  /**
   * Create summary generator function for context management
   * Uses the current provider and account to generate summaries
   */
  private createSummaryGenerator(
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext,
  ): SummaryGenerator {
    return async (messages: ContextChatMessage[], prompt?: string): Promise<string> => {
      try {
        console.log('[SummaryGenerator] Generating summary for', messages.length, 'messages')

        const summaryPrompt =
          prompt ||
          'Please summarize the following conversation concisely, keeping key information and context:'

        const conversationText = messages
          .map((msg) => {
            const role = msg.role.toUpperCase()
            const content = formatMessageForSummary(msg)
            return `${role}: ${content}`
          })
          .join('\n\n')

        const summaryRequest: ChatCompletionRequest = {
          model: actualModel,
          messages: [
            {
              role: 'system',
              content: summaryPrompt,
            },
            {
              role: 'user',
              content: conversationText,
            },
          ],
          stream: false,
          temperature: 0.3,
        }

        const result = await this.doForward(summaryRequest, account, provider, actualModel, context)

        if (result.success && result.body) {
          const summaryContent = result.body.choices?.[0]?.message?.content || ''
          console.log(
            '[SummaryGenerator] Summary generated successfully, length:',
            summaryContent.length,
          )
          return summaryContent
        }

        console.warn('[SummaryGenerator] Failed to generate summary:', result.error)
        return 'Failed to generate conversation summary.'
      } catch (error) {
        console.error('[SummaryGenerator] Error generating summary:', error)
        return 'Failed to generate conversation summary due to an error.'
      }
    }
  }

  /**
   * Forward Chat Completions Request
   */
  async forwardChatCompletion(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext,
  ): Promise<ForwardResult> {
    const startTime = Date.now()
    const config = storeManager.getConfig()
    const maxRetries = config.retryCount

    let lastError: string | undefined
    let lastStatus: number | undefined
    let lastToolCallingFailure: ForwardResult['toolCallingFailure']
    let currentSelection = { account, provider, actualModel }
    const attemptedAccountIds = new Set<string>()
    let toolRepairAttempted = false
    let toolRepairTelemetry: ForwardResult['toolRepair']

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      throwIfAborted(context.signal)
      let modifiedRequest = request

      if (
        config.contextManagement?.enabled &&
        modifiedRequest.messages &&
        modifiedRequest.messages.length > 0
      ) {
        try {
          const summaryGenerator = this.createSummaryGenerator(
            currentSelection.account,
            currentSelection.provider,
            currentSelection.actualModel,
            context,
          )

          const contextService = createContextManagementService(
            config.contextManagement || {},
            summaryGenerator,
          )

          const originalCount = modifiedRequest.messages.length
          const contextMessages: ContextChatMessage[] =
            modifiedRequest.messages.map(cloneChatMessage)

          const processResult = await contextService.process(contextMessages)
          throwIfAborted(context.signal)

          if (processResult.finalCount !== originalCount) {
            console.log(
              `[Forwarder] Context management applied: ${originalCount} -> ${processResult.finalCount} messages`,
            )

            processResult.strategyResults.forEach((result) => {
              if (result.trimmed) {
                console.log(
                  `[Forwarder] Strategy ${result.strategyName}: ${result.originalCount} -> ${result.processedCount} messages`,
                )
              }
            })

            modifiedRequest = {
              ...modifiedRequest,
              // Keep OpenAI metadata such as tool_calls, tool_call_id, and
              // name.  Dropping those fields makes a retained tool exchange
              // invalid on the next provider request.
              messages: processResult.messages.map(cloneChatMessage),
            }
          }
        } catch (error) {
          if (context.signal?.aborted) throw getAbortReason(context.signal)
          console.error('[Forwarder] Context management failed:', error)
        }
      }

      try {
        let result = await this.doForward(
          modifiedRequest,
          currentSelection.account,
          currentSelection.provider,
          currentSelection.actualModel,
          context,
        )
        throwIfAborted(context.signal)

        if (shouldAttemptToolRepair(result, modifiedRequest, toolRepairAttempted)) {
          throwIfAborted(context.signal)
          toolRepairAttempted = true
          const firstResult = result
          const repairRequest = createToolRepairRequest(modifiedRequest, result)
          const failureDiagnostics = result.toolCallingFailure?.diagnostics
          const originalReasoningContent = result.toolCallingFailure?.reasoningContent
          const firstValidationIssues =
            result.toolCallingFailure?.validationIssues ??
            failureDiagnostics?.schemaValidationIssues ??
            []
          const firstValidationErrors =
            result.toolCallingFailure?.validationErrors ??
            failureDiagnostics?.schemaValidationErrors ??
            (result.error ? [result.error] : [])
          const repairStartedAt = Date.now()
          storeManager.addLog('warn', 'Retrying required tool call once with reasoning disabled', {
            requestId: context.requestId,
            providerId: currentSelection.provider.id,
            accountId: currentSelection.account.id,
            model: request.model,
            data: {
              repair_attempted: true,
              repair_attempts: 1,
              repair_result: 'attempting',
              first_validation_error: firstValidationErrors[0] ?? null,
              first_validation_errors: [...firstValidationErrors],
              first_field_types: firstValidationIssues.map((issue) => ({
                json_pointer: issue.jsonPointer,
                expected: issue.expected,
                actual_type: issue.actualType,
                keyword: issue.keyword,
              })),
              repair_temperature: repairRequest.temperature,
              repair_reasoning_effort: repairRequest.reasoning_effort,
              repair_parallel_tool_calls: repairRequest.parallel_tool_calls,
              toolName: result.toolCallingFailure?.toolName,
              failureCode: result.toolCallingFailure?.code,
              reason: result.error,
              selectedProtocol: failureDiagnostics?.protocol,
              detectedProtocols: failureDiagnostics?.detectedProtocols,
              rawResponsePreview: failureDiagnostics?.rawContentPreview,
            },
          })

          const rawRepaired = await this.doForward(
            repairRequest,
            currentSelection.account,
            currentSelection.provider,
            currentSelection.actualModel,
            context,
          )
          throwIfAborted(context.signal)
          const constrainedRepair = enforceSingleToolRepairResult(
            rawRepaired,
            result.toolCallingFailure?.toolName,
          )
          toolRepairTelemetry = createToolRepairTelemetry(firstResult, constrainedRepair)
          storeManager.addLog(
            constrainedRepair.success ? 'info' : 'error',
            constrainedRepair.success
              ? 'Bounded tool call repair succeeded'
              : 'Bounded tool call repair failed',
            {
              requestId: context.requestId,
              providerId: currentSelection.provider.id,
              accountId: currentSelection.account.id,
              model: request.model,
              latency: Date.now() - repairStartedAt,
              data: {
                ...createToolRepairLogData(toolRepairTelemetry),
                tool_name: result.toolCallingFailure?.toolName,
                failure_code: constrainedRepair.toolCallingFailure?.code ?? null,
              },
            },
          )
          const repaired =
            constrainedRepair.success && constrainedRepair.body
              ? {
                  ...constrainedRepair,
                  body: mergeOriginalReasoningIntoRepairResponse(
                    constrainedRepair.body,
                    modifiedRequest,
                    originalReasoningContent,
                  ),
                }
              : constrainedRepair
          const repairedWithTelemetry = {
            ...repaired,
            toolRepair: toolRepairTelemetry,
          }
          result =
            repairedWithTelemetry.success && request.stream && repairedWithTelemetry.body
              ? {
                  ...repairedWithTelemetry,
                  body: undefined,
                  stream: this.createBufferedResponseStream(
                    repairedWithTelemetry.body,
                    currentSelection.actualModel,
                  ),
                  skipTransform: true,
                  latency: Date.now() - startTime,
                }
              : {
                  ...repairedWithTelemetry,
                  latency: Date.now() - startTime,
                  ...(!repairedWithTelemetry.success && repairedWithTelemetry.toolCallingFailure
                    ? {
                        toolCallingFailure: {
                          ...repairedWithTelemetry.toolCallingFailure,
                          repairAttempted: true,
                          repairAttempts: 1,
                        },
                      }
                    : {}),
                }
        }

        if (result.success) {
          // Non-streaming requests are finished here; the account lock can be
          // released. For streaming, the lock stays held until the stream
          // completes and the route layer releases it.
          if (!(request.stream && result.stream)) {
            loadBalancer.releaseAccount(currentSelection.account.id)
          }
          return {
            ...result,
            contextMessages: modifiedRequest.messages.map(cloneChatMessage),
            ...(toolRepairTelemetry ? { toolRepair: toolRepairTelemetry } : {}),
            selection: currentSelection,
          }
        }

        lastError = result.error
        lastStatus = result.status ?? getForwardErrorMessageStatus(result.error)
        lastToolCallingFailure = result.toolCallingFailure
          ? { ...result.toolCallingFailure }
          : undefined
      } catch (error) {
        if (context.signal?.aborted) throw getAbortReason(context.signal)
        const failure = createForwardFailure(error, startTime)
        lastError = failure.error
        lastStatus = failure.status
        lastToolCallingFailure = failure.toolCallingFailure
          ? { ...failure.toolCallingFailure }
          : undefined
      }

      if (!isRetryableStatus(lastStatus, lastError) || attempt >= maxRetries) {
        if (shouldMarkAccountFailed(lastStatus, lastError, lastToolCallingFailure)) {
          recordAccountFailure(currentSelection, lastStatus)
        }
        // The final attempt is done; release its lock so the account can be
        // picked by subsequent requests again.
        loadBalancer.releaseAccount(currentSelection.account.id)
        break
      }

      if (shouldMarkAccountFailed(lastStatus, lastError, lastToolCallingFailure)) {
        recordAccountFailure(currentSelection, lastStatus)
      }

      // The direct connection was rate-limited, blocked, or failed at the
      // transport layer. Route the reattempt through an outbound proxy so the
      // next request leaves from a different IP. Await readiness (bounded) so
      // this request's retry actually goes through the proxy. When already in
      // proxy mode, rotate the Clash node to a different exit IP.
      if (shouldRouteThroughProxy(lastStatus, lastError)) {
        if (outboundProxyManager.isProxyMode()) {
          await outboundProxyManager.rotateProxy()
        } else {
          await outboundProxyManager.ensureProxyForRequest()
        }
      }

      attemptedAccountIds.add(currentSelection.account.id)
      // This account's attempt has finished (it failed). Release its lock so
      // the concurrency counter reflects reality when we retry another account.
      loadBalancer.releaseAccount(currentSelection.account.id)
      const nextSelection = loadBalancer.selectAccount(
        request.model,
        config.loadBalanceStrategy,
        currentSelection.provider.id,
        undefined,
        attemptedAccountIds,
      )

      if (nextSelection) {
        storeManager.addLog('warn', 'Retrying request with another account', {
          requestId: context.requestId,
          providerId: nextSelection.provider.id,
          accountId: nextSelection.account.id,
          model: request.model,
        })
        currentSelection = nextSelection
      } else {
        // Every matching account has been tried. Retrying the last account can
        // still recover from a transient provider-wide outage.
        attemptedAccountIds.clear()
        await this.delay(proxyStatusManager.getConfig().retryDelay || 5000, context.signal)
      }
    }

    return {
      success: false,
      status: lastStatus,
      error: lastError || 'Request failed after retries',
      latency: Date.now() - startTime,
      selection: currentSelection,
      ...(lastToolCallingFailure ? { toolCallingFailure: lastToolCallingFailure } : {}),
      ...(toolRepairTelemetry ? { toolRepair: toolRepairTelemetry } : {}),
    }
  }

  /**
   * Execute Forward
   */
  private async doForward(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext,
  ): Promise<ForwardResult> {
    const startTime = Date.now()
    throwIfAborted(context.signal)

    const dedicatedForwarder = this.providerForwarders.find((forwarder) =>
      forwarder.matches(provider),
    )
    if (dedicatedForwarder) {
      return dedicatedForwarder.forward(request, account, provider, actualModel, startTime, context)
    }

    try {
      const chatPath = provider.chatPath || '/chat/completions'
      const url = this.buildUrl(provider, chatPath)
      const headers = this.buildHeaders(provider, account)
      const body = this.buildRequestBody(request, actualModel, account)

      const axiosConfig: AxiosRequestConfig = {
        method: 'POST',
        url,
        headers,
        data: body,
        timeout: getRemainingTimeout(
          context.deadlineAt,
          context.timeoutMs ?? proxyStatusManager.getConfig().timeout,
        ),
        signal: context.signal,
        responseType: request.stream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(axiosConfig)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (request.stream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      if (context.signal?.aborted) throw getAbortReason(context.signal)
      const latency = Date.now() - startTime

      if (error instanceof AxiosError) {
        return {
          success: false,
          status: error.response?.status,
          error: error.message,
          latency,
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Build URL
   */
  private buildUrl(provider: Provider, path: string): string {
    let baseUrl = provider.apiEndpoint

    if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1)
    }

    if (!path.startsWith('/')) {
      path = '/' + path
    }

    if (baseUrl.includes('/v1') && path.startsWith('/v1')) {
      path = path.slice(3)
    }

    return `${baseUrl}${path}`
  }

  /**
   * Build Request Headers
   */
  private buildHeaders(provider: Provider, account: Account): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...provider.headers,
    }

    const credentials = account.credentials

    if (credentials.token) {
      headers['Authorization'] = `Bearer ${credentials.token}`
    } else if (credentials.apiKey) {
      headers['Authorization'] = `Bearer ${credentials.apiKey}`
    } else if (credentials.accessToken) {
      headers['Authorization'] = `Bearer ${credentials.accessToken}`
    } else if (credentials.refreshToken) {
      headers['Authorization'] = `Bearer ${credentials.refreshToken}`
    }

    if (credentials.cookie) {
      headers['Cookie'] = credentials.cookie
    }

    if (credentials.sessionKey) {
      headers['X-Session-Key'] = credentials.sessionKey
    }

    return headers
  }

  /**
   * Build Request Body
   */
  private buildRequestBody(
    request: ChatCompletionRequest,
    actualModel: string,
    account: Account,
  ): any {
    const body: any = {
      model: actualModel,
      messages: request.messages,
      stream: request.stream || false,
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    if (request.top_p !== undefined) {
      body.top_p = request.top_p
    }

    if (request.n !== undefined) {
      body.n = request.n
    }

    if (request.stop !== undefined) {
      body.stop = request.stop
    }

    if (request.max_tokens !== undefined) {
      body.max_tokens = request.max_tokens
    }

    if (request.presence_penalty !== undefined) {
      body.presence_penalty = request.presence_penalty
    }

    if (request.frequency_penalty !== undefined) {
      body.frequency_penalty = request.frequency_penalty
    }

    if (request.logit_bias !== undefined) {
      body.logit_bias = request.logit_bias
    }

    if (request.user !== undefined) {
      body.user = request.user
    }

    return body
  }

  /**
   * Extract Response Headers
   */
  private extractHeaders(headers: any): Record<string, string> {
    const result: Record<string, string> = {}

    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        result[key] = value
      } else if (Array.isArray(value)) {
        result[key] = value.join(', ')
      }
    }

    return result
  }

  /**
   * Extract Error Message
   */
  private extractErrorMessage(response: AxiosResponse): string {
    if (response.data) {
      if (typeof response.data === 'string') {
        return response.data
      }

      if (response.data.error?.message) {
        return response.data.error.message
      }

      if (response.data.message) {
        return response.data.message
      }

      if (response.data.msg) {
        return response.data.msg
      }

      try {
        return JSON.stringify(response.data)
      } catch {
        return 'Unknown error'
      }
    }

    return `HTTP ${response.status}`
  }

  /**
   * Delay
   */
  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
    if (signal.aborted) return Promise.reject(getAbortReason(signal))

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer)
        reject(getAbortReason(signal))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Forward Request to Specified URL
   */
  async forwardToUrl(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: any,
    isStream: boolean = false,
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    try {
      const config: AxiosRequestConfig = {
        method,
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: isStream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(config)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (isStream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }
}

export const requestForwarder = new RequestForwarder()
export default requestForwarder
