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
import { DeepSeekAdapter } from './adapters/deepseek'
import { DeepSeekStreamHandler } from './adapters/deepseek-stream'
import { GLMAdapter, GLMStreamHandler } from './adapters/glm'
import { KimiAdapter, KimiStreamHandler } from './adapters/kimi'
import { MimoAdapter, MimoStreamHandler } from './adapters/mimo'
import { QwenAdapter, QwenStreamHandler } from './adapters/qwen'
import {
  QwenAiAdapter,
  QwenAiRequestValidationError,
  QwenAiStreamHandler,
  type QwenAiUpstreamCompletionState,
} from './adapters/qwen-ai'
import { ZaiAdapter, ZaiStreamHandler } from './adapters/zai'
import { MiniMaxAdapter, MiniMaxStreamHandler } from './adapters/minimax'
import { PerplexityAdapter } from './adapters/perplexity'
import { PerplexityStreamHandler } from './adapters/perplexity-stream'
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
import {
  getAbortReason,
  getRemainingTimeout,
  throwIfAborted,
} from './requestLifecycle'

function shouldDeleteSession(): boolean {
  return sessionManager.shouldDeleteAfterChat()
}

function getForwardErrorStatus(error: unknown): number | undefined {
  if (error instanceof QwenAiRequestValidationError) return 400
  if (error instanceof ToolCallingResponseError) return error.status
  if (axios.isAxiosError(error)) return error.response?.status

  if (error && typeof error === 'object' && 'status' in error) {
    const status = Number((error as { status?: unknown }).status)
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status
  }

  return undefined
}

function getForwardErrorMessageStatus(message?: string): number | undefined {
  if (!message) return undefined
  if (isToolCallingResponseErrorMessage(message)) return 502

  const match = /(?:HTTP|status(?: code)?)\s*[:=]?\s*([45]\d\d)/i.exec(message)
  return match ? Number(match[1]) : undefined
}

function isRetryableStatus(status: number | undefined, error?: string): boolean {
  if (isToolCallingResponseErrorMessage(error)) return false
  return status === undefined
    || status === 401
    || status === 403
    || status === 408
    || status === 409
    || status === 425
    || status === 429
    || status >= 500
}

/**
 * Whether the failure signals that the direct connection IP was rate-limited,
 * blocked, or had transport-level problems — conditions where routing the
 * reattempt through an outbound proxy is worth trying. Authentication failures
 * (401) are excluded because they are credential problems, not IP problems.
 */
export function shouldRouteThroughProxy(
  status: number | undefined,
  error?: string,
): boolean {
  if (isToolCallingResponseErrorMessage(error)) return false
  if (status === undefined) return true
  return status === 403
    || status === 408
    || status === 409
    || status === 425
    || status === 429
    || (status >= 500 && status <= 599)
}

function shouldMarkAccountFailed(
  status: number | undefined,
  error?: string,
  toolCallingFailure?: ForwardResult['toolCallingFailure'],
): boolean {
  if (
    toolCallingFailure?.code === 'upstream_multiplexed_response'
    || toolCallingFailure?.code === 'upstream_incomplete_response'
  ) return false
  if (isToolCallingResponseErrorMessage(error)) return false
  return status === undefined
    || status === 401
    || status === 403
    || status === 429
    || (status !== undefined && status >= 500)
}

function recordAccountFailure(
  selection: AccountSelection,
  status: number | undefined,
): void {
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

class QwenAiMultiplexedResponseError extends Error {
  readonly status = 502
  readonly diagnostics: ToolCallingTransformResult['plan']['diagnostics']

  constructor(diagnostics: ToolCallingTransformResult['plan']['diagnostics']) {
    super('Qwen upstream multiplexed multiple unidentified responses; retry with a fresh chat')
    this.name = 'QwenAiMultiplexedResponseError'
    this.diagnostics = diagnostics
  }
}

class QwenAiIncompleteResponseError extends Error {
  readonly status = 502
  readonly diagnostics: ToolCallingTransformResult['plan']['diagnostics']
  readonly toolName?: string
  readonly reasoningContent?: string

  constructor(
    completionState: Exclude<QwenAiUpstreamCompletionState, 'complete'>,
    diagnostics: ToolCallingTransformResult['plan']['diagnostics'],
    toolName?: string,
    reasoningContent?: string,
  ) {
    const reason = completionState === 'output_limit'
      ? 'the output limit was reached'
      : 'the upstream response ended early'
    super(`Qwen upstream did not complete the required tool call because ${reason}`)
    this.name = 'QwenAiIncompleteResponseError'
    this.diagnostics = diagnostics
    this.toolName = toolName
    this.reasoningContent = reasoningContent
  }
}

function createForwardFailure(error: unknown, startTime: number): ForwardResult {
  const message = error instanceof Error ? error.message : 'Unknown error'
  const toolCallingFailure: ForwardResult['toolCallingFailure'] = error instanceof ToolCallingResponseError
    ? {
        code: error.code,
        toolName: error.toolName,
        repairable: error.repairable,
        diagnostics: error.diagnostics,
        validationErrors: [...error.validationErrors],
        validationIssues: error.validationIssues.map((issue) => ({ ...issue })),
        rejectedArguments: error.rejectedArguments,
        reasoningContent: error.reasoningContent,
      }
    : error instanceof QwenAiMultiplexedResponseError
      ? {
          code: 'upstream_multiplexed_response',
          repairable: false,
          diagnostics: error.diagnostics,
        }
      : error instanceof QwenAiIncompleteResponseError
        ? {
            code: 'upstream_incomplete_response',
            toolName: error.toolName,
            repairable: true,
            diagnostics: error.diagnostics,
            reasoningContent: error.reasoningContent,
          }
      : undefined
  return {
    success: false,
    status: getForwardErrorStatus(error),
    error: message,
    latency: Date.now() - startTime,
    ...(toolCallingFailure ? { toolCallingFailure } : {}),
  }
}

type ProviderForwarder = {
  name: string
  matches: (provider: Provider) => boolean
  forward: (
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    context: ProxyContext,
  ) => Promise<ForwardResult>
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

  private readonly providerForwarders: ProviderForwarder[] = [
    {
      name: 'deepseek',
      matches: DeepSeekAdapter.isDeepSeekProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardDeepSeek(request, account, provider, actualModel, startTime),
    },
    {
      name: 'glm',
      matches: GLMAdapter.isGLMProvider,
      forward: (request, account, provider, actualModel, startTime, context) =>
        this.forwardGLM(request, account, provider, actualModel, startTime, context),
    },
    {
      name: 'kimi',
      matches: KimiAdapter.isKimiProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardKimi(request, account, provider, actualModel, startTime),
    },
    {
      name: 'qwen',
      matches: QwenAdapter.isQwenProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardQwen(request, account, provider, actualModel, startTime),
    },
    {
      name: 'qwen-ai',
      matches: QwenAiAdapter.isQwenAiProvider,
      forward: (request, account, provider, actualModel, startTime, context) =>
        this.forwardQwenAi(request, account, provider, actualModel, startTime, context),
    },
    {
      name: 'zai',
      matches: ZaiAdapter.isZaiProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardZai(request, account, provider, actualModel, startTime),
    },
    {
      name: 'minimax',
      matches: MiniMaxAdapter.isMiniMaxProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardMiniMax(request, account, provider, actualModel, startTime),
    },
    {
      name: 'mimo',
      matches: MimoAdapter.isMimoProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardMimo(request, account, provider, actualModel, startTime),
    },
    {
      name: 'perplexity',
      matches: PerplexityAdapter.isPerplexityProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardPerplexity(request, account, provider, actualModel, startTime),
    },
  ]

  /**
   * Transform request for prompt-based tool calling
   * For models that don't support native function calling
   * Delegates tool normalization, prompt injection, and parser planning to ToolCallingEngine.
   */
  private transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider
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

  private applyQwenToolCallsToResponse(
    result: any,
    transformed: ToolCallingTransformResult,
    alternativeContents: string[],
    hasUnidentifiedMultiplexedResponse: boolean,
    upstreamCompletionState: QwenAiUpstreamCompletionState,
  ): any {
    const originalContent = typeof result?.choices?.[0]?.message?.content === 'string'
      ? result.choices[0].message.content
      : ''
    const candidates = [...alternativeContents, originalContent].filter(
      (content, index, values) => content.trim() && values.indexOf(content) === index
    )
    const partialToolName = this.getKnownPartialQwenToolName(originalContent, transformed)

    if (candidates.length <= 1) {
      try {
        this.applyToolCallsToResponse(result, transformed)
        return result
      } catch (error) {
        if (hasUnidentifiedMultiplexedResponse && error instanceof ToolCallingResponseError) {
          throw new QwenAiMultiplexedResponseError(
            error.diagnostics ?? transformed.plan.diagnostics
          )
        }
        if (
          error instanceof ToolCallingResponseError
          && (upstreamCompletionState !== 'complete' || partialToolName)
        ) {
          throw new QwenAiIncompleteResponseError(
            upstreamCompletionState === 'complete' ? 'incomplete' : upstreamCompletionState,
            error.diagnostics ?? transformed.plan.diagnostics,
            partialToolName,
            error.reasoningContent,
          )
        }
        throw error
      }
    }

    const baseDiagnostics = { ...transformed.plan.diagnostics }
    let lastError: unknown
    let candidateAttempts: NonNullable<
      ToolCallingTransformResult['plan']['diagnostics']['candidateAttempts']
    > = []

    for (const [candidateIndex, content] of candidates.entries()) {
      const candidateResult = {
        ...result,
        choices: (result.choices ?? []).map((choice: any, index: number) =>
          index === 0
            ? {
                ...choice,
                message: { ...choice.message, content },
              }
            : choice
        ),
      }
      transformed.plan.diagnostics = {
        ...baseDiagnostics,
        candidateContentCount: candidates.length,
        selectedCandidateIndex: candidateIndex,
      }

      try {
        this.applyToolCallsToResponse(candidateResult, transformed)
        return candidateResult
      } catch (error) {
        lastError = error
        const diagnostics = error instanceof ToolCallingResponseError
          ? error.diagnostics
          : undefined
        candidateAttempts = [...candidateAttempts, {
          index: candidateIndex,
          chars: content.length,
          parserFormat: diagnostics?.parserFormat,
          detectedProtocols: diagnostics?.detectedProtocols
            ? [...diagnostics.detectedProtocols]
            : undefined,
          malformedReason: diagnostics?.malformedReason,
          rawContentPreview: diagnostics?.rawContentPreview,
        }]
      }
    }

    const finalDiagnostics = lastError instanceof ToolCallingResponseError
      ? {
          ...(lastError.diagnostics ?? transformed.plan.diagnostics),
          candidateAttempts,
        }
      : {
          ...transformed.plan.diagnostics,
          candidateAttempts,
        }

    if (hasUnidentifiedMultiplexedResponse) {
      throw new QwenAiMultiplexedResponseError(finalDiagnostics)
    }

    if (
      lastError instanceof ToolCallingResponseError
      && (upstreamCompletionState !== 'complete' || partialToolName)
    ) {
      throw new QwenAiIncompleteResponseError(
        upstreamCompletionState === 'complete' ? 'incomplete' : upstreamCompletionState,
        finalDiagnostics,
        partialToolName,
        lastError instanceof ToolCallingResponseError ? lastError.reasoningContent : undefined,
      )
    }

    if (lastError instanceof ToolCallingResponseError) {
      throw new ToolCallingResponseError(
        lastError.message,
        lastError.code,
        finalDiagnostics,
        lastError.validationErrors,
        lastError.toolName,
        lastError.repairable,
        lastError.reasoningContent,
        lastError.validationIssues,
        lastError.rejectedArguments,
      )
    }

    throw lastError ?? new Error('Qwen upstream candidates did not contain a valid tool call')
  }

  private getKnownPartialQwenToolName(
    content: string,
    transformed: ToolCallingTransformResult,
  ): string | undefined {
    const match = /(?:<\|FLUXMELD\|invoke|<invoke)\b[^>]*\bname\s*=\s*["']([^"']+)["']/i.exec(content)
    const name = match?.[1]?.trim()
    return name && transformed.plan.allowedToolNames.has(name) ? name : undefined
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
      stream.write(`data: ${JSON.stringify({
        ...baseChunk,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}\n\n`)

      if (message.reasoning_content) {
        stream.write(`data: ${JSON.stringify({
          ...baseChunk,
          choices: [{
            index: 0,
            delta: { reasoning_content: message.reasoning_content },
            finish_reason: null,
          }],
        })}\n\n`)
      }

      if (message.content) {
        stream.write(`data: ${JSON.stringify({
          ...baseChunk,
          choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }],
        })}\n\n`)
      }

      for (const [index, toolCall] of (message.tool_calls ?? []).entries()) {
        const { rawText, ...publicToolCall } = toolCall
        void rawText
        stream.write(`data: ${JSON.stringify({
          ...baseChunk,
          choices: [{
            index: 0,
            delta: { tool_calls: [{ ...publicToolCall, index }] },
            finish_reason: null,
          }],
        })}\n\n`)
      }

      stream.write(`data: ${JSON.stringify({
        ...baseChunk,
        choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }],
        ...(result?.usage && { usage: result.usage }),
      })}\n\n`)
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
    context: ProxyContext
  ): SummaryGenerator {
    return async (messages: ContextChatMessage[], prompt?: string): Promise<string> => {
      try {
        console.log('[SummaryGenerator] Generating summary for', messages.length, 'messages')

        const summaryPrompt = prompt || 'Please summarize the following conversation concisely, keeping key information and context:'

        const conversationText = messages
          .map(msg => {
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

        const result = await this.doForward(
          summaryRequest,
          account,
          provider,
          actualModel,
          context
        )

        if (result.success && result.body) {
          const summaryContent = result.body.choices?.[0]?.message?.content || ''
          console.log('[SummaryGenerator] Summary generated successfully, length:', summaryContent.length)
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
    context: ProxyContext
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

      if (config.contextManagement?.enabled && modifiedRequest.messages && modifiedRequest.messages.length > 0) {
        try {
          const summaryGenerator = this.createSummaryGenerator(
            currentSelection.account,
            currentSelection.provider,
            currentSelection.actualModel,
            context
          )

          const contextService = createContextManagementService(
            config.contextManagement || {},
            summaryGenerator
          )

          const originalCount = modifiedRequest.messages.length
          const contextMessages: ContextChatMessage[] = modifiedRequest.messages.map(cloneChatMessage)

          const processResult = await contextService.process(contextMessages)
          throwIfAborted(context.signal)

          if (processResult.finalCount !== originalCount) {
            console.log(
              `[Forwarder] Context management applied: ${originalCount} -> ${processResult.finalCount} messages`
            )

            processResult.strategyResults.forEach(result => {
              if (result.trimmed) {
                console.log(
                  `[Forwarder] Strategy ${result.strategyName}: ${result.originalCount} -> ${result.processedCount} messages`
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
          const firstValidationIssues = result.toolCallingFailure?.validationIssues
            ?? failureDiagnostics?.schemaValidationIssues
            ?? []
          const firstValidationErrors = result.toolCallingFailure?.validationErrors
            ?? failureDiagnostics?.schemaValidationErrors
            ?? (result.error ? [result.error] : [])
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
          const repaired = constrainedRepair.success && constrainedRepair.body
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
          result = repairedWithTelemetry.success && request.stream && repairedWithTelemetry.body
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
                ...(!repairedWithTelemetry.success && repairedWithTelemetry.toolCallingFailure ? {
                  toolCallingFailure: {
                    ...repairedWithTelemetry.toolCallingFailure,
                    repairAttempted: true,
                    repairAttempts: 1,
                  },
                } : {}),
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
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()
    throwIfAborted(context.signal)

    const dedicatedForwarder = this.providerForwarders.find(forwarder => forwarder.matches(provider))
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
   * DeepSeek Dedicated Forward
   */
  private async forwardDeepSeek(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new DeepSeekAdapter(provider, account)
      
      const { response, sessionId } = await adapter.chatCompletion({
        model: request.model,
        messages: transformedRequest.messages as any,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
        web_search: transformedRequest.web_search,
        reasoning_effort: transformedRequest.reasoning_effort,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        if (response.data) {
          if (typeof response.data === 'string') {
            errorMessage = response.data
          } else if (response.data.msg) {
            errorMessage = response.data.msg
          } else if (response.data.error?.message) {
            errorMessage = response.data.error.message
          }
        }
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      // Prepare callback for deleting session
      const deleteSessionCallback = shouldDeleteSession()
        ? async () => {
            try {
              await adapter.deleteSession(sessionId)
            } catch (error) {
              console.error('[DeepSeek] Failed to delete session:', error)
            }
          }
        : undefined

      // DeepSeek always returns streaming response
      const handler = new DeepSeekStreamHandler(
        actualModel,
        sessionId,
        deleteSessionCallback,
        transformedRequest.web_search,
        transformedRequest.reasoning_effort,
        transformed.plan,
        request.model
      )

      if (request.stream && transformed.plan.shouldParseResponse) {
        const bufferedResult = await handler.handleNonStream(response.data)
        this.applyToolCallsToResponse(bufferedResult, transformed)
        if (deleteSessionCallback) await deleteSessionCallback()
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: this.createBufferedResponseStream(bufferedResult, actualModel),
          skipTransform: true,
          latency: Date.now() - startTime,
          providerSessionId: sessionId,
        }
      }
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      // Non-streaming requests need to collect stream data and convert
      const result = await handler.handleNonStream(response.data)
      
      this.applyToolCallsToResponse(result, transformed)
      
      if (deleteSessionCallback) {
        await deleteSessionCallback()
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      return createForwardFailure(error, startTime)
    }
  }

  /**
   * GLM Dedicated Forward
   */
  private async forwardGLM(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    context: ProxyContext,
  ): Promise<ForwardResult> {
    try {
      throwIfAborted(context.signal)
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new GLMAdapter(provider, account)
      const glmReasoningEffort = transformedRequest.reasoning_effort
        ?? transformedRequest.reasoningEffort
        ?? transformedRequest.enable_thinking
      const createGLMRequestOptions = () => ({
        signal: context.signal,
        timeoutMs: getRemainingTimeout(
          context.deadlineAt,
          context.timeoutMs ?? proxyStatusManager.getConfig().timeout,
        ),
        requestId: context.requestId,
      })
      const { response, conversationId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformedRequest.messages,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
        web_search: transformedRequest.web_search,
        reasoningEffort: glmReasoningEffort,
        deep_research: transformedRequest.deep_research,
      }, createGLMRequestOptions())
      throwIfAborted(context.signal)

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        if (response.data) {
          if (typeof response.data === 'string') {
            errorMessage = response.data
          } else if (response.data.msg) {
            errorMessage = response.data.msg
          } else if (response.data.message) {
            errorMessage = response.data.message
          } else if (response.data.error?.message) {
            errorMessage = response.data.error.message
          }
        }
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const handler = new GLMStreamHandler(actualModel, undefined, undefined, transformed.plan)

      if (request.stream && transformed.plan.shouldParseResponse) {
        const bufferedResult = await handler.handleNonStream(response.data, createGLMRequestOptions())
        throwIfAborted(context.signal)
        this.applyToolCallsToResponse(bufferedResult, transformed)
        const convId = handler.getConversationId()
        if (shouldDeleteSession() && convId) await adapter.deleteConversation(convId)
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: this.createBufferedResponseStream(bufferedResult, actualModel),
          skipTransform: true,
          latency: Date.now() - startTime,
          providerSessionId: convId || undefined,
        }
      }
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)
        
        // If delete session after chat is enabled, we need to handle it after stream ends
        if (shouldDeleteSession()) {
          const originalEnd = transformedStream.end.bind(transformedStream)
          transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            const convId = handler.getConversationId()
            if (convId) {
              adapter.deleteConversation(convId).catch(err => {
                console.error('[GLM] Failed to delete session:', err)
              })
            }
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: handler.getConversationId(),
        }
      }

      const result = await handler.handleNonStream(response.data, createGLMRequestOptions())
      throwIfAborted(context.signal)
      
      this.applyToolCallsToResponse(result, transformed)
      
      if (shouldDeleteSession()) {
        const convId = handler.getConversationId()
        if (convId) {
          await adapter.deleteConversation(convId)
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: handler.getConversationId() ?? undefined,
      }
    } catch (error) {
      if (context.signal?.aborted) throw getAbortReason(context.signal)
      return createForwardFailure(error, startTime)
    }
  }

  private async forwardKimi(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new KimiAdapter(provider, account)
      const kimiReasoningEffort = request.reasoning_effort
        ?? request.reasoningEffort
        ?? request.enable_thinking
      const { response, conversationId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages,
        stream: request.stream,
        temperature: request.temperature,
        reasoningEffort: kimiReasoningEffort,
        enableWebSearch: !!request.web_search,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const handler = new KimiStreamHandler(
        actualModel,
        conversationId,
        true,
        transformed.plan,
      )

      if (request.stream && transformed.plan.shouldParseResponse) {
        const bufferedResult = await handler.handleNonStream(response.data)
        this.applyToolCallsToResponse(bufferedResult, transformed)
        const realChatId = handler.getConversationId()
        if (shouldDeleteSession() && realChatId) await adapter.deleteConversation(realChatId)
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: this.createBufferedResponseStream(bufferedResult, actualModel),
          skipTransform: true,
          latency: Date.now() - startTime,
          providerSessionId: realChatId || undefined,
        }
      }
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)
        
        // Add delete conversation callback if needed
        if (shouldDeleteSession()) {
          const originalEnd = transformedStream.end.bind(transformedStream)
          transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            const realChatId = handler.getConversationId()
            if (realChatId) {
              adapter.deleteConversation(realChatId).catch(err => {
                console.error('[Kimi] Failed to delete conversation:', err)
              })
            }
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: undefined,
        }
      }

      const result = await handler.handleNonStream(response.data)

      this.applyToolCallsToResponse(result, transformed)

      if (shouldDeleteSession()) {
        const realChatId = handler.getConversationId()
        if (realChatId) {
          await adapter.deleteConversation(realChatId)
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: handler.getConversationId() ?? undefined,
      }
    } catch (error) {
      return createForwardFailure(error, startTime)
    }
  }

  /**
   * Qwen Dedicated Forward
   */
  private async forwardQwen(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new QwenAdapter(provider, account)
      const { response, sessionId, reqId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformedRequest.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        enableThinking: isReasoningEnabled(request.reasoning_effort),
        enableWebSearch: !!request.web_search,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        const errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteSessionCallback = shouldDeleteSession()
        ? async (sid: string) => {
            try {
              await adapter.deleteSession(sid)
            } catch (err) {
              console.error('[Qwen] Failed to delete session:', err)
            }
          }
        : undefined

      const handler = new QwenStreamHandler(actualModel, deleteSessionCallback, transformed.plan)

      if (request.stream && transformed.plan.shouldParseResponse) {
        const bufferedResult = await handler.handleNonStream(response.data, response)
        this.applyToolCallsToResponse(bufferedResult, transformed)
        const sid = handler.getSessionId()
        if (deleteSessionCallback && sid) await deleteSessionCallback(sid)
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: this.createBufferedResponseStream(bufferedResult, actualModel),
          skipTransform: true,
          latency: Date.now() - startTime,
          providerSessionId: sessionId,
        }
      }

      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data, response)

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      const result = await handler.handleNonStream(response.data, response)

      this.applyToolCallsToResponse(result, transformed)

      const sid = handler.getSessionId()
      if (deleteSessionCallback && sid) {
        await deleteSessionCallback(sid)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      return createForwardFailure(error, startTime)
    }
  }

  /**
   * Qwen AI (International) Dedicated Forward
   */
  private async forwardQwenAi(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    context: ProxyContext,
  ): Promise<ForwardResult> {
    try {
      throwIfAborted(context.signal)
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new QwenAiAdapter(provider, account)
      const { response, chatId, parentId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        enable_thinking: request.enable_thinking,
        thinking_budget: request.thinking_budget,
        reasoning_effort: request.reasoning_effort,
        max_tokens: request.max_tokens,
        max_completion_tokens: request.max_completion_tokens,
        // History serialization must keep the selected client protocol even
        // when this turn disables response parsing with tool_choice: none.
        toolProtocol: transformed.plan.protocol,
      }, {
        signal: context.signal,
        timeoutMs: getRemainingTimeout(
          context.deadlineAt,
          context.timeoutMs ?? proxyStatusManager.getConfig().timeout,
        ),
      })
      throwIfAborted(context.signal)

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        const errorMessage = `HTTP ${response.status}`
        if (typeof response.data?.destroy === 'function') response.data.destroy()
        if (shouldDeleteSession()) {
          await adapter.deleteChat(chatId)
        }
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession()
        ? (completedChatId: string) => {
            void adapter.deleteChat(completedChatId).catch(err => {
              console.error('[QwenAI] Failed to delete chat:', err)
            })
          }
        : undefined
      const handler = new QwenAiStreamHandler(actualModel, deleteChatCallback, {
        maxTokens: request.max_tokens,
        maxCompletionTokens: request.max_completion_tokens,
      })
      handler.setChatId(chatId)

      if (request.stream) {
        // Managed tool output must be parsed as one complete response before
        // emitting OpenAI tool-call deltas. Otherwise Qwen's XML markers leak
        // through as ordinary streamed content.
        if (transformed.plan.shouldParseResponse) {
          const bufferedResult = await handler.handleNonStream(response.data)
          transformed.plan.diagnostics = {
            ...transformed.plan.diagnostics,
            upstreamEventSummary: handler.getUpstreamEventSummary(),
          }
          const parsedBufferedResult = this.applyQwenToolCallsToResponse(
            bufferedResult,
            transformed,
            handler.getAlternativeAnswerContents(),
            handler.hasUnidentifiedMultiplexedResponse(),
            handler.getUpstreamCompletionState(),
          )
          return {
            success: true,
            status: response.status,
            headers: this.extractHeaders(response.headers),
            stream: this.createBufferedResponseStream(parsedBufferedResult, actualModel),
            skipTransform: true,
            latency: Date.now() - startTime,
            providerSessionId: chatId,
          }
        }

        const transformedStream = await handler.handleStream(response.data)

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      const result = await handler.handleNonStream(response.data)

      transformed.plan.diagnostics = {
        ...transformed.plan.diagnostics,
        upstreamEventSummary: handler.getUpstreamEventSummary(),
      }
      const parsedResult = this.applyQwenToolCallsToResponse(
        result,
        transformed,
        handler.getAlternativeAnswerContents(),
        handler.hasUnidentifiedMultiplexedResponse(),
        handler.getUpstreamCompletionState(),
      )

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: parsedResult,
        latency,
        providerSessionId: chatId,
      }
    } catch (error) {
      return createForwardFailure(error, startTime)
    }
  }

  /**
   * Z.ai Dedicated Forward
   */
  private async forwardZai(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardZai] actualModel:', actualModel)
    console.log('[forwardZai] provider.modelMappings:', provider.modelMappings)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new ZaiAdapter(provider, account)
      const { response, chatId, requestId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        web_search: request.web_search,
        reasoning_effort: request.reasoning_effort,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession()
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (error) {
              console.error('[Z.ai] Failed to delete chat:', error)
            }
          }
        : undefined

      const handler = new ZaiStreamHandler(actualModel, deleteChatCallback)
      handler.setChatId(chatId)

      if (request.stream === true && transformed.plan.shouldParseResponse) {
        const bufferedResult = await handler.handleNonStream(response.data)
        this.applyToolCallsToResponse(bufferedResult, transformed)
        if (deleteChatCallback) await deleteChatCallback(chatId)
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: this.createBufferedResponseStream(bufferedResult, actualModel),
          skipTransform: true,
          latency: Date.now() - startTime,
          providerSessionId: chatId,
        }
      }
      
      if (request.stream === true) {
        const transformedStream = await handler.handleStream(response.data)
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      const result = await handler.handleNonStream(response.data)

      this.applyToolCallsToResponse(result, transformed)
      
      if (deleteChatCallback) {
        await deleteChatCallback(chatId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: chatId,
      }
    } catch (error) {
      return createForwardFailure(error, startTime)
    }
  }

  /**
   * MiniMax Dedicated Forward
   */
  private async forwardMiniMax(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardMiniMax] actualModel:', actualModel)
    console.log('[forwardMiniMax] provider.modelMappings:', provider.modelMappings)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new MiniMaxAdapter(provider, account)
      const { response, stream, chatId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
      })

      const latency = Date.now() - startTime

      if (response && response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession()
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (error) {
              console.error('[MiniMax] Failed to delete chat:', error)
            }
          }
        : undefined

      if (request.stream === true && stream) {
        console.log('[forwardMiniMax] Using polling stream')
        
        if (deleteChatCallback) {
          const originalStream = stream.stream as unknown as PassThrough
          const originalEnd = originalStream.end.bind(originalStream)
          originalStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            deleteChatCallback(chatId).catch(err => {
              console.error('[MiniMax] Failed to delete chat:', err)
            })
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: stream.stream as any,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      if (response) {
        this.applyToolCallsToResponse(response.data, transformed)
        
        if (deleteChatCallback) {
          await deleteChatCallback(chatId)
        }

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          body: response.data,
          latency,
          providerSessionId: chatId,
        }
      }

      return {
        success: false,
        error: 'No response or stream received',
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

  /**
   * Mimo Dedicated Forward
   * Uses Mimo adapter for Xiaomi AI Studio
   */
  private async forwardMimo(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }
      const adapter = new MimoAdapter(provider, account)

      const { response, conversationId, query } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.originalModel,
        messages: transformedRequest.messages as any,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteSessionCallback = shouldDeleteSession()
        ? async (sessionId: string) => {
            try {
              await adapter.deleteSession(sessionId)
            } catch (error) {
              console.error('[Mimo] Failed to delete session:', error)
            }
          }
        : undefined

      const handler = new MimoStreamHandler(actualModel, conversationId, 'separate', transformed.plan)

      if (request.stream && transformed.plan.shouldParseResponse) {
        const buffered = await handler.handleNonStream(response.data)
        const bufferedResult = JSON.parse(buffered)
        this.applyToolCallsToResponse(bufferedResult, transformed)
        await adapter.generateConversationTitle(
          conversationId,
          query,
          handler.getAssistantContentForTitle(),
        )
        if (deleteSessionCallback) await deleteSessionCallback(conversationId)
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: this.createBufferedResponseStream(bufferedResult, actualModel),
          skipTransform: true,
          latency: Date.now() - startTime,
          providerSessionId: conversationId,
        }
      }

      if (request.stream) {
        const transformedStream = new PassThrough()
        const openAIStream = handler.handleStream(response.data)

        ;(async () => {
          try {
            for await (const chunk of openAIStream) {
              transformedStream.write(chunk)
            }
            await adapter.generateConversationTitle(
              conversationId,
              query,
              handler.getAssistantContentForTitle()
            )
            if (deleteSessionCallback) {
              await deleteSessionCallback(conversationId)
            }
            transformedStream.end()
          } catch (error) {
            console.error('[Mimo] Stream error:', error)
            transformedStream.end()
          }
        })()

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: conversationId,
        }
      }

      const result = await handler.handleNonStream(response.data)
      const parsedResult = JSON.parse(result)
      this.applyToolCallsToResponse(parsedResult, transformed)
      await adapter.generateConversationTitle(
        conversationId,
        query,
        handler.getAssistantContentForTitle()
      )
      if (deleteSessionCallback) {
        await deleteSessionCallback(conversationId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: parsedResult,
        skipTransform: true,
        latency,
        providerSessionId: conversationId,
      }
    } catch (error) {
      console.error('[Mimo] Forward error:', error)
      return createForwardFailure(error, startTime)
    }
  }

  /**
   * Perplexity Dedicated Forward
   * Uses Electron's net API to bypass Cloudflare protection
   */
  private async forwardPerplexity(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardPerplexity] actualModel:', actualModel)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new PerplexityAdapter(provider, account)
      
      const { stream, sessionId } = await adapter.chatCompletion({
        model: actualModel,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
      })

      const latency = Date.now() - startTime

      if (request.stream === true) {
        const deleteSessionCallback = shouldDeleteSession()
          ? async () => {
              try {
                await adapter.deleteSession(sessionId)
              } catch (error) {
                console.error('[Perplexity] Failed to delete session:', error)
              }
            }
          : undefined

        const handler = new PerplexityStreamHandler(actualModel, sessionId, deleteSessionCallback, adapter)
        const transformedStream = await handler.handleStream(stream)
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: transformedStream as any,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      const handler = new PerplexityStreamHandler(actualModel, sessionId, undefined, adapter)
      const result = await handler.handleNonStream(stream)
      
      this.applyToolCallsToResponse(result, transformed)
      
      if (shouldDeleteSession()) {
        await adapter.deleteSession(sessionId)
      }
      
      return {
        success: true,
        status: 200,
        headers: {},
        body: result,
        latency,
        providerSessionId: sessionId,
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
    account: Account
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
    if (!signal) return new Promise(resolve => setTimeout(resolve, ms))
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
    isStream: boolean = false
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
