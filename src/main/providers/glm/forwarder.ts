import { GLMAdapter, GLMStreamHandler } from './adapter'
import { proxyStatusManager } from '../../proxy/status'
import { getAbortReason, getRemainingTimeout, throwIfAborted } from '../../proxy/requestLifecycle'
import { createForwardFailure } from '../../proxy/forwarders/errors'
import type { ForwarderServices, ProviderForwarder } from '../../proxy/forwarders/types'

export function createGLMForwarder(services: ForwarderServices): ProviderForwarder {
  return {
    name: 'glm',
    matches: GLMAdapter.isGLMProvider,
    async forward(request, account, provider, actualModel, startTime, context) {
      try {
        throwIfAborted(context.signal)
        const transformed = services.transformRequestForPromptToolUse(request, provider)
        const transformedRequest = {
          ...request,
          messages: transformed.messages,
          tools: transformed.tools,
        }

        const adapter = new GLMAdapter(provider, account)
        const glmReasoningEffort =
          transformedRequest.reasoning_effort ??
          transformedRequest.reasoningEffort ??
          transformedRequest.enable_thinking
        const createGLMRequestOptions = () => ({
          signal: context.signal,
          timeoutMs: getRemainingTimeout(
            context.deadlineAt,
            context.timeoutMs ?? proxyStatusManager.getConfig().timeout,
          ),
          requestId: context.requestId,
        })
        const { response, conversationId } = await adapter.chatCompletion(
          {
            model: actualModel,
            originalModel: request.model,
            messages: transformedRequest.messages,
            stream: transformedRequest.stream,
            temperature: transformedRequest.temperature,
            web_search: transformedRequest.web_search,
            reasoningEffort: glmReasoningEffort,
            deep_research: transformedRequest.deep_research,
          },
          createGLMRequestOptions(),
        )
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
          return { success: false, status: response.status, error: errorMessage, latency }
        }

        const handler = new GLMStreamHandler(actualModel, undefined, undefined, transformed.plan)

        if (request.stream && transformed.plan.shouldParseResponse) {
          const bufferedResult = await handler.handleNonStream(
            response.data,
            createGLMRequestOptions(),
          )
          throwIfAborted(context.signal)
          services.applyToolCallsToResponse(bufferedResult, transformed)
          const convId = handler.getConversationId()
          if (services.shouldDeleteSession() && convId) await adapter.deleteConversation(convId)
          return {
            success: true,
            status: response.status,
            headers: services.extractHeaders(response.headers),
            stream: services.createBufferedResponseStream(bufferedResult, actualModel),
            skipTransform: true,
            latency: Date.now() - startTime,
            providerSessionId: convId || undefined,
          }
        }

        if (request.stream) {
          const transformedStream = await handler.handleStream(response.data)

          if (services.shouldDeleteSession()) {
            const originalEnd = transformedStream.end.bind(transformedStream)
            transformedStream.end = function (chunk?: any, encoding?: any, callback?: any) {
              const convId = handler.getConversationId()
              if (convId) {
                adapter.deleteConversation(convId).catch((err) => {
                  console.error('[GLM] Failed to delete session:', err)
                })
              }
              return originalEnd(chunk, encoding, callback)
            }
          }

          return {
            success: true,
            status: response.status,
            headers: services.extractHeaders(response.headers),
            stream: transformedStream,
            skipTransform: true,
            latency,
            providerSessionId: handler.getConversationId(),
          }
        }

        const result = await handler.handleNonStream(response.data, createGLMRequestOptions())
        throwIfAborted(context.signal)

        services.applyToolCallsToResponse(result, transformed)

        if (services.shouldDeleteSession()) {
          const convId = handler.getConversationId()
          if (convId) await adapter.deleteConversation(convId)
        }

        return {
          success: true,
          status: response.status,
          headers: services.extractHeaders(response.headers),
          body: result,
          latency,
          providerSessionId: handler.getConversationId() ?? undefined,
        }
      } catch (error) {
        if (context.signal?.aborted) throw getAbortReason(context.signal)
        return createForwardFailure(error, startTime)
      }
    },
  }
}
