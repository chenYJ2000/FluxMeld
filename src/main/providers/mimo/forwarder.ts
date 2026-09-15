import { PassThrough } from 'stream'
import { MimoAdapter, MimoStreamHandler } from './adapter'
import { createForwardFailure } from '../../proxy/forwarders/errors'
import type { ForwarderServices, ProviderForwarder } from '../../proxy/forwarders/types'

export function createMimoForwarder(services: ForwarderServices): ProviderForwarder {
  return {
    name: 'mimo',
    matches: MimoAdapter.isMimoProvider,
    async forward(request, account, provider, actualModel, startTime) {
      try {
        const transformed = services.transformRequestForPromptToolUse(request, provider)
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
          return {
            success: false,
            status: response.status,
            error: `HTTP ${response.status}`,
            latency,
          }
        }

        const deleteSessionCallback = services.shouldDeleteSession()
          ? async (sessionId: string) => {
              try {
                await adapter.deleteSession(sessionId)
              } catch (error) {
                console.error('[Mimo] Failed to delete session:', error)
              }
            }
          : undefined

        const handler = new MimoStreamHandler(
          actualModel,
          conversationId,
          'separate',
          transformed.plan,
        )

        if (request.stream && transformed.plan.shouldParseResponse) {
          const buffered = await handler.handleNonStream(response.data)
          const bufferedResult = JSON.parse(buffered)
          services.applyToolCallsToResponse(bufferedResult, transformed)
          await adapter.generateConversationTitle(
            conversationId,
            query,
            handler.getAssistantContentForTitle(),
          )
          if (deleteSessionCallback) await deleteSessionCallback(conversationId)
          return {
            success: true,
            status: response.status,
            headers: services.extractHeaders(response.headers),
            stream: services.createBufferedResponseStream(bufferedResult, actualModel),
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
                handler.getAssistantContentForTitle(),
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
            headers: services.extractHeaders(response.headers),
            stream: transformedStream,
            skipTransform: true,
            latency,
            providerSessionId: conversationId,
          }
        }

        const result = await handler.handleNonStream(response.data)
        const parsedResult = JSON.parse(result)
        services.applyToolCallsToResponse(parsedResult, transformed)
        await adapter.generateConversationTitle(
          conversationId,
          query,
          handler.getAssistantContentForTitle(),
        )
        if (deleteSessionCallback) await deleteSessionCallback(conversationId)

        return {
          success: true,
          status: response.status,
          headers: services.extractHeaders(response.headers),
          body: parsedResult,
          skipTransform: true,
          latency,
          providerSessionId: conversationId,
        }
      } catch (error) {
        console.error('[Mimo] Forward error:', error)
        return createForwardFailure(error, startTime)
      }
    },
  }
}
