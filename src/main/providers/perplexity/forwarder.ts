import { PerplexityAdapter } from './adapter'
import { PerplexityStreamHandler } from './stream'
import type { ForwarderServices, ProviderForwarder } from '../../proxy/forwarders/types'

export function createPerplexityForwarder(services: ForwarderServices): ProviderForwarder {
  return {
    name: 'perplexity',
    matches: PerplexityAdapter.isPerplexityProvider,
    async forward(request, account, provider, actualModel, startTime) {
      console.log('[forwardPerplexity] actualModel:', actualModel)
      try {
        const transformed = services.transformRequestForPromptToolUse(request, provider)

        const adapter = new PerplexityAdapter(provider, account)

        const { stream, sessionId } = await adapter.chatCompletion({
          model: actualModel,
          messages: transformed.messages as any,
          stream: request.stream,
          temperature: request.temperature,
        })

        const latency = Date.now() - startTime

        if (request.stream === true) {
          const deleteSessionCallback = services.shouldDeleteSession()
            ? async () => {
                try {
                  await adapter.deleteSession(sessionId)
                } catch (error) {
                  console.error('[Perplexity] Failed to delete session:', error)
                }
              }
            : undefined

          const handler = new PerplexityStreamHandler(
            actualModel,
            sessionId,
            deleteSessionCallback,
            adapter,
          )
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

        services.applyToolCallsToResponse(result, transformed)

        if (services.shouldDeleteSession()) {
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
    },
  }
}
