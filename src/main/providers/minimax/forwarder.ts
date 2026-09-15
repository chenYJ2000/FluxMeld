import { PassThrough } from 'stream'
import { MiniMaxAdapter } from './adapter'
import { createForwardFailure } from '../../proxy/forwarders/errors'
import type { ForwarderServices, ProviderForwarder } from '../../proxy/forwarders/types'

export function createMiniMaxForwarder(services: ForwarderServices): ProviderForwarder {
  return {
    name: 'minimax',
    matches: MiniMaxAdapter.isMiniMaxProvider,
    async forward(request, account, provider, actualModel, startTime) {
      console.log('[forwardMiniMax] actualModel:', actualModel)
      console.log('[forwardMiniMax] provider.modelMappings:', provider.modelMappings)
      try {
        const transformed = services.transformRequestForPromptToolUse(request, provider)

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
                console.error('[MiniMax] Failed to delete chat:', error)
              }
            }
          : undefined

        if (request.stream === true && stream) {
          console.log('[forwardMiniMax] Using polling stream')

          if (deleteChatCallback) {
            const originalStream = stream.stream as unknown as PassThrough
            const originalEnd = originalStream.end.bind(originalStream)
            originalStream.end = function (chunk?: any, encoding?: any, callback?: any) {
              deleteChatCallback(chatId).catch((err) => {
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
          services.applyToolCallsToResponse(response.data, transformed)

          if (deleteChatCallback) await deleteChatCallback(chatId)

          return {
            success: true,
            status: response.status,
            headers: services.extractHeaders(response.headers),
            body: response.data,
            latency,
            providerSessionId: chatId,
          }
        }

        return { success: false, error: 'No response or stream received', latency }
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
