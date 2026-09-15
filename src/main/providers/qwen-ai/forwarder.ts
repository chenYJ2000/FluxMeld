import {
  QwenAiAdapter,
  QwenAiStreamHandler,
  type QwenAiUpstreamCompletionState,
} from './adapter'
import { ToolCallingResponseError } from '../../proxy/toolCalling/ToolCallingEngine'
import type { ToolCallingTransformResult } from '../../proxy/toolCalling/types'
import { proxyStatusManager } from '../../proxy/status'
import { getRemainingTimeout, throwIfAborted } from '../../proxy/requestLifecycle'
import {
  QwenAiIncompleteResponseError,
  QwenAiMultiplexedResponseError,
  createForwardFailure,
} from '../../proxy/forwarders/errors'
import type { ForwarderServices, ProviderForwarder } from '../../proxy/forwarders/types'

function getKnownPartialQwenToolName(
  content: string,
  transformed: ToolCallingTransformResult,
): string | undefined {
  const match = /(?:<\|FLUXMELD\|invoke|<invoke)\b[^>]*\bname\s*=\s*["']([^"']+)["']/i.exec(content)
  const name = match?.[1]?.trim()
  return name && transformed.plan.allowedToolNames.has(name) ? name : undefined
}

/**
 * Resolve Qwen AI tool calls across the candidate answer contents returned by
 * the upstream when its response may be multiplexed or incomplete.
 */
function applyQwenToolCallsToResponse(
  services: ForwarderServices,
  result: any,
  transformed: ToolCallingTransformResult,
  alternativeContents: string[],
  hasUnidentifiedMultiplexedResponse: boolean,
  upstreamCompletionState: QwenAiUpstreamCompletionState,
): any {
  const originalContent =
    typeof result?.choices?.[0]?.message?.content === 'string'
      ? result.choices[0].message.content
      : ''
  const candidates = [...alternativeContents, originalContent].filter(
    (content, index, values) => content.trim() && values.indexOf(content) === index,
  )
  const partialToolName = getKnownPartialQwenToolName(originalContent, transformed)

  if (candidates.length <= 1) {
    try {
      services.applyToolCallsToResponse(result, transformed)
      return result
    } catch (error) {
      if (hasUnidentifiedMultiplexedResponse && error instanceof ToolCallingResponseError) {
        throw new QwenAiMultiplexedResponseError(error.diagnostics ?? transformed.plan.diagnostics)
      }
      if (
        error instanceof ToolCallingResponseError &&
        (upstreamCompletionState !== 'complete' || partialToolName)
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
          : choice,
      ),
    }
    transformed.plan.diagnostics = {
      ...baseDiagnostics,
      candidateContentCount: candidates.length,
      selectedCandidateIndex: candidateIndex,
    }

    try {
      services.applyToolCallsToResponse(candidateResult, transformed)
      return candidateResult
    } catch (error) {
      lastError = error
      const diagnostics = error instanceof ToolCallingResponseError ? error.diagnostics : undefined
      candidateAttempts = [
        ...candidateAttempts,
        {
          index: candidateIndex,
          chars: content.length,
          parserFormat: diagnostics?.parserFormat,
          detectedProtocols: diagnostics?.detectedProtocols
            ? [...diagnostics.detectedProtocols]
            : undefined,
          malformedReason: diagnostics?.malformedReason,
          rawContentPreview: diagnostics?.rawContentPreview,
        },
      ]
    }
  }

  const finalDiagnostics =
    lastError instanceof ToolCallingResponseError
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
    lastError instanceof ToolCallingResponseError &&
    (upstreamCompletionState !== 'complete' || partialToolName)
  ) {
    throw new QwenAiIncompleteResponseError(
      upstreamCompletionState === 'complete' ? 'incomplete' : upstreamCompletionState,
      finalDiagnostics,
      partialToolName,
      lastError.reasoningContent,
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

export function createQwenAiForwarder(services: ForwarderServices): ProviderForwarder {
  return {
    name: 'qwen-ai',
    matches: QwenAiAdapter.isQwenAiProvider,
    async forward(request, account, provider, actualModel, startTime, context) {
      try {
        throwIfAborted(context.signal)
        const transformed = services.transformRequestForPromptToolUse(request, provider)

        const adapter = new QwenAiAdapter(provider, account)
        const { response, chatId } = await adapter.chatCompletion(
          {
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
          },
          {
            signal: context.signal,
            timeoutMs: getRemainingTimeout(
              context.deadlineAt,
              context.timeoutMs ?? proxyStatusManager.getConfig().timeout,
            ),
          },
        )
        throwIfAborted(context.signal)

        const latency = Date.now() - startTime

        if (response.status >= 400) {
          const errorMessage = `HTTP ${response.status}`
          if (typeof response.data?.destroy === 'function') response.data.destroy()
          if (services.shouldDeleteSession()) {
            await adapter.deleteChat(chatId)
          }
          return { success: false, status: response.status, error: errorMessage, latency }
        }

        const deleteChatCallback = services.shouldDeleteSession()
          ? (completedChatId: string) => {
              void adapter.deleteChat(completedChatId).catch((err) => {
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
            const parsedBufferedResult = applyQwenToolCallsToResponse(
              services,
              bufferedResult,
              transformed,
              handler.getAlternativeAnswerContents(),
              handler.hasUnidentifiedMultiplexedResponse(),
              handler.getUpstreamCompletionState(),
            )
            return {
              success: true,
              status: response.status,
              headers: services.extractHeaders(response.headers),
              stream: services.createBufferedResponseStream(parsedBufferedResult, actualModel),
              skipTransform: true,
              latency: Date.now() - startTime,
              providerSessionId: chatId,
            }
          }

          const transformedStream = await handler.handleStream(response.data)
          return {
            success: true,
            status: response.status,
            headers: services.extractHeaders(response.headers),
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
        const parsedResult = applyQwenToolCallsToResponse(
          services,
          result,
          transformed,
          handler.getAlternativeAnswerContents(),
          handler.hasUnidentifiedMultiplexedResponse(),
          handler.getUpstreamCompletionState(),
        )

        return {
          success: true,
          status: response.status,
          headers: services.extractHeaders(response.headers),
          body: parsedResult,
          latency,
          providerSessionId: chatId,
        }
      } catch (error) {
        return createForwardFailure(error, startTime)
      }
    },
  }
}
