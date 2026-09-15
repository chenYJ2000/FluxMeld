import { DeepSeekAdapter } from '../adapters/deepseek'
import { DeepSeekStreamHandler } from '../adapters/deepseek-stream'
import { createForwardFailure } from './errors'
import type { ForwarderServices, ProviderForwarder } from './types'

export function createDeepSeekForwarder(services: ForwarderServices): ProviderForwarder {
  return {
    name: 'deepseek',
    matches: DeepSeekAdapter.isDeepSeekProvider,
    async forward(request, account, provider, actualModel, startTime) {
      try {
        const transformed = services.transformRequestForPromptToolUse(request, provider)
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
          return { success: false, status: response.status, error: errorMessage, latency }
        }

        const deleteSessionCallback = services.shouldDeleteSession()
          ? async () => {
              try {
                await adapter.deleteSession(sessionId)
              } catch (error) {
                console.error('[DeepSeek] Failed to delete session:', error)
              }
            }
          : undefined

        const handler = new DeepSeekStreamHandler(
          actualModel,
          sessionId,
          deleteSessionCallback,
          transformedRequest.web_search,
          transformedRequest.reasoning_effort,
          transformed.plan,
          request.model,
        )

        if (request.stream && transformed.plan.shouldParseResponse) {
          const bufferedResult = await handler.handleNonStream(response.data)
          services.applyToolCallsToResponse(bufferedResult, transformed)
          if (deleteSessionCallback) await deleteSessionCallback()
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
          const transformedStream = await handler.handleStream(response.data)
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

        const result = await handler.handleNonStream(response.data)
        services.applyToolCallsToResponse(result, transformed)
        if (deleteSessionCallback) await deleteSessionCallback()

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
