import { QwenAdapter, QwenStreamHandler } from './adapter'
import { isReasoningEnabled } from '../common/reasoning'
import { createForwardFailure } from '../../proxy/forwarders/errors'
import type { ForwarderServices, ProviderForwarder } from '../../proxy/forwarders/types'

export function createQwenForwarder(services: ForwarderServices): ProviderForwarder {
  return {
    name: 'qwen',
    matches: QwenAdapter.isQwenProvider,
    async forward(request, account, provider, actualModel, startTime) {
      try {
        const transformed = services.transformRequestForPromptToolUse(request, provider)
        const transformedRequest = {
          ...request,
          messages: transformed.messages,
          tools: transformed.tools,
        }

        const adapter = new QwenAdapter(provider, account)
        const { response, sessionId } = await adapter.chatCompletion({
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
          return {
            success: false,
            status: response.status,
            error: `HTTP ${response.status}`,
            latency,
          }
        }

        const deleteSessionCallback = services.shouldDeleteSession()
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
          services.applyToolCallsToResponse(bufferedResult, transformed)
          const sid = handler.getSessionId()
          if (deleteSessionCallback && sid) await deleteSessionCallback(sid)
          return {
            success: true,
            status: response.status,
            headers: services.extractHeaders(response.headers),
            stream: services.createBufferedResponseStream(bufferedResult, actualModel),
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
            headers: services.extractHeaders(response.headers),
            stream: transformedStream,
            skipTransform: true,
            latency,
            providerSessionId: sessionId,
          }
        }

        const result = await handler.handleNonStream(response.data, response)
        services.applyToolCallsToResponse(result, transformed)

        const sid = handler.getSessionId()
        if (deleteSessionCallback && sid) await deleteSessionCallback(sid)

        return {
          success: true,
          status: response.status,
          headers: services.extractHeaders(response.headers),
          body: result,
          latency,
          providerSessionId: sessionId,
        }
      } catch (error) {
        return createForwardFailure(error, startTime)
      }
    },
  }
}
