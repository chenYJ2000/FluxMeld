import { KimiAdapter, KimiStreamHandler } from './adapter'
import { createForwardFailure } from '../../proxy/forwarders/errors'
import type { ForwarderServices, ProviderForwarder } from '../../proxy/forwarders/types'

export function createKimiForwarder(services: ForwarderServices): ProviderForwarder {
  return {
    name: 'kimi',
    matches: KimiAdapter.isKimiProvider,
    async forward(request, account, provider, actualModel, startTime) {
      try {
        const transformed = services.transformRequestForPromptToolUse(request, provider)

        const adapter = new KimiAdapter(provider, account)
        const kimiReasoningEffort =
          request.reasoning_effort ?? request.reasoningEffort ?? request.enable_thinking
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
          return {
            success: false,
            status: response.status,
            error: `HTTP ${response.status}`,
            latency,
          }
        }

        const handler = new KimiStreamHandler(actualModel, conversationId, true, transformed.plan)

        if (request.stream && transformed.plan.shouldParseResponse) {
          const bufferedResult = await handler.handleNonStream(response.data)
          services.applyToolCallsToResponse(bufferedResult, transformed)
          const realChatId = handler.getConversationId()
          if (services.shouldDeleteSession() && realChatId) {
            await adapter.deleteConversation(realChatId)
          }
          return {
            success: true,
            status: response.status,
            headers: services.extractHeaders(response.headers),
            stream: services.createBufferedResponseStream(bufferedResult, actualModel),
            skipTransform: true,
            latency: Date.now() - startTime,
            providerSessionId: realChatId || undefined,
          }
        }

        if (request.stream) {
          const transformedStream = await handler.handleStream(response.data)

          if (services.shouldDeleteSession()) {
            const originalEnd = transformedStream.end.bind(transformedStream)
            transformedStream.end = function (chunk?: any, encoding?: any, callback?: any) {
              const realChatId = handler.getConversationId()
              if (realChatId) {
                adapter.deleteConversation(realChatId).catch((err) => {
                  console.error('[Kimi] Failed to delete conversation:', err)
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
            providerSessionId: undefined,
          }
        }

        const result = await handler.handleNonStream(response.data)
        services.applyToolCallsToResponse(result, transformed)

        if (services.shouldDeleteSession()) {
          const realChatId = handler.getConversationId()
          if (realChatId) await adapter.deleteConversation(realChatId)
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
        return createForwardFailure(error, startTime)
      }
    },
  }
}
