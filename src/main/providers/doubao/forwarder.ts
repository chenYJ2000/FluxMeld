import { DoubaoAdapter, DoubaoStreamHandler } from './adapter'
import { proxyStatusManager } from '../../proxy/status'
import { getAbortReason, getRemainingTimeout, throwIfAborted } from '../../proxy/requestLifecycle'
import { createForwardFailure } from '../../proxy/forwarders/errors'
import type { ForwarderServices, ProviderForwarder } from '../../proxy/forwarders/types'

function isDeepThink(model: string): boolean {
  return /deep-?think|thinking|reason/.test(model.toLowerCase())
}

function isAutoCot(model: string): boolean {
  return /auto-?cot/.test(model.toLowerCase())
}

export function createDoubaoForwarder(services: ForwarderServices): ProviderForwarder {
  return {
    name: 'doubao',
    matches: DoubaoAdapter.isDoubaoProvider,
    async forward(request, account, provider, actualModel, startTime, context) {
      try {
        throwIfAborted(context.signal)
        const transformed = services.transformRequestForPromptToolUse(request, provider)

        const adapter = new DoubaoAdapter(provider, account)
        const modelForDetection = request.originalModel || actualModel || request.model || ''
        const requestOptions = () => ({
          signal: context.signal,
          timeoutMs: getRemainingTimeout(
            context.deadlineAt,
            context.timeoutMs ?? proxyStatusManager.getConfig().timeout,
          ),
          requestId: context.requestId,
        })

        const response = await adapter.chatCompletion(
          {
            model: actualModel,
            originalModel: request.originalModel,
            messages: transformed.messages as any,
            stream: request.stream,
            useDeepThink: isDeepThink(modelForDetection),
            useAutoCot: isAutoCot(modelForDetection),
          },
          requestOptions(),
        )
        throwIfAborted(context.signal)

        const latency = Date.now() - startTime

        if (response.status >= 400) {
          const errorMessage = `HTTP ${response.status}`
          if (response.data && typeof response.data.destroy === 'function') response.data.destroy()
          return { success: false, status: response.status, error: errorMessage, latency }
        }

        const handler = new DoubaoStreamHandler(actualModel)

        if (request.stream) {
          const transformedStream = await handler.handleStream(response.data, requestOptions())

          if (services.shouldDeleteSession()) {
            const originalEnd = transformedStream.end.bind(transformedStream)
            transformedStream.end = function (chunk?: any, encoding?: any, callback?: any) {
              const conversationId = handler.getConversationId()
              if (conversationId) {
                void adapter.deleteConversation(conversationId).catch((error) => {
                  console.error('[Doubao] Failed to delete session:', error)
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
            providerSessionId: handler.getConversationId() || undefined,
          }
        }

        const result = await handler.handleNonStream(response.data, requestOptions())
        throwIfAborted(context.signal)

        if (services.shouldDeleteSession()) {
          const conversationId = handler.getConversationId()
          if (conversationId) await adapter.deleteConversation(conversationId)
        }

        return {
          success: true,
          status: response.status,
          headers: services.extractHeaders(response.headers),
          body: result,
          latency,
          providerSessionId: handler.getConversationId() || undefined,
        }
      } catch (error) {
        if (context.signal?.aborted) throw getAbortReason(context.signal)
        return createForwardFailure(error, startTime)
      }
    },
  }
}
