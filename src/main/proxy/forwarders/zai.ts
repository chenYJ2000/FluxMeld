import { ZaiAdapter, ZaiStreamHandler } from '../adapters/zai'
import { createForwardFailure } from './errors'
import type { ForwarderServices, ProviderForwarder } from './types'

export function createZaiForwarder(services: ForwarderServices): ProviderForwarder {
  return {
    name: 'zai',
    matches: ZaiAdapter.isZaiProvider,
    async forward(request, account, provider, actualModel, startTime) {
      console.log('[forwardZai] actualModel:', actualModel)
      console.log('[forwardZai] provider.modelMappings:', provider.modelMappings)
      try {
        const transformed = services.transformRequestForPromptToolUse(request, provider)

        const adapter = new ZaiAdapter(provider, account)
        const { response, chatId } = await adapter.chatCompletion({
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
          return {
            success: false,
            status: response.status,
            error: `HTTP ${response.status}`,
            latency,
          }
        }

        const deleteChatCallback = services.shouldDeleteSession()
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
          services.applyToolCallsToResponse(bufferedResult, transformed)
          if (deleteChatCallback) await deleteChatCallback(chatId)
          return {
            success: true,
            status: response.status,
            headers: services.extractHeaders(response.headers),
            stream: services.createBufferedResponseStream(bufferedResult, actualModel),
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
            headers: services.extractHeaders(response.headers),
            stream: transformedStream,
            skipTransform: true,
            latency,
            providerSessionId: chatId,
          }
        }

        const result = await handler.handleNonStream(response.data)
        services.applyToolCallsToResponse(result, transformed)

        if (deleteChatCallback) await deleteChatCallback(chatId)

        return {
          success: true,
          status: response.status,
          headers: services.extractHeaders(response.headers),
          body: result,
          latency,
          providerSessionId: chatId,
        }
      } catch (error) {
        return createForwardFailure(error, startTime)
      }
    },
  }
}
