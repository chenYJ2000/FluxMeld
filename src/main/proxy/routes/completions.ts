/**
 * Proxy Service Module - Completions Route (Optional)
 * Implements /v1/completions route (legacy API)
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { loadBalancer } from '../loadbalancer'
import { requestForwarder } from '../forwarder'
import { streamHandler } from '../stream'
import { proxyStatusManager } from '../status'
import { modelMapper } from '../modelMapper'
import { storeManager } from '../../store/store'

const router = new Router({ prefix: '/v1' })

interface CompletionRequest {
  model: string
  prompt: string | string[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  n?: number
  stream?: boolean
  stop?: string | string[]
  echo?: boolean
}

/**
 * Generate request ID
 */
function generateRequestId(): string {
  return `cmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Convert prompt to messages format
 */
function promptToMessages(prompt: string | string[]): Array<{ role: string; content: string }> {
  if (Array.isArray(prompt)) {
    return prompt.map((p, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: p,
    }))
  }

  return [{ role: 'user', content: prompt }]
}

/**
 * Handle Completions request
 */
router.post('/completions', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = generateRequestId()

  let request: CompletionRequest
  try {
    request = ctx.request.body as CompletionRequest
  } catch (error) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Invalid request body',
        type: 'invalid_request_error',
      },
    }
    return
  }

  if (!request.model) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: model',
        type: 'invalid_request_error',
        param: 'model',
      },
    }
    return
  }

  if (request.prompt === undefined) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: prompt',
        type: 'invalid_request_error',
        param: 'prompt',
      },
    }
    return
  }

  const config = storeManager.getConfig()
  const preferredProviderId = modelMapper.getPreferredProvider(request.model)
  const preferredAccountId = modelMapper.getPreferredAccount(request.model)

  const selection = loadBalancer.selectAccount(
    request.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId
  )

  if (!selection) {
    ctx.status = 503
    ctx.body = {
      error: {
        message: `No available account for model: ${request.model}`,
        type: 'service_unavailable_error',
        code: 'no_available_account',
      },
    }
    return
  }

  const { account, provider, actualModel } = selection

  const chatRequest = {
    model: actualModel,
    messages: promptToMessages(request.prompt),
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    n: request.n,
    stream: request.stream,
    stop: request.stop,
  }

  proxyStatusManager.recordRequestStart(request.model, provider.id, account.id)

  try {
    const result = await requestForwarder.forwardChatCompletion(
      chatRequest,
      account,
      provider,
      actualModel,
      {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: request.model,
        actualModel,
        startTime,
        isStream: request.stream || false,
      }
    )

    const latency = Date.now() - startTime
    const resolvedSelection = result.selection ?? selection
    const usedAccount = resolvedSelection.account
    const usedProvider = resolvedSelection.provider
    const usedActualModel = resolvedSelection.actualModel

    if (!result.success) {
      proxyStatusManager.recordRequestFailure(latency)

      ctx.status = result.status || 500
      ctx.body = {
        error: {
          message: result.error || 'Request failed',
          type: 'api_error',
        },
      }
      return
    }

    const recordSuccess = (finalLatency: number) => {
      loadBalancer.clearAccountFailure(usedAccount.id)
      proxyStatusManager.recordRequestSuccess(finalLatency)
      const latestAccount = storeManager.getAccountById(usedAccount.id) ?? usedAccount
      storeManager.updateAccount(usedAccount.id, {
        lastUsed: Date.now(),
        requestCount: (latestAccount.requestCount || 0) + 1,
        todayUsed: (latestAccount.todayUsed || 0) + 1,
      })
      storeManager.addLog('debug', 'Request succeeded', {
        requestId,
        providerId: usedProvider.id,
        accountId: usedAccount.id,
        model: request.model,
        actualModel: usedActualModel,
        latency: finalLatency,
        isStream: request.stream,
      })
    }

    if (request.stream && result.stream) {
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      let streamSettled = false
      const finishSuccess = () => {
        if (streamSettled) return
        streamSettled = true
        loadBalancer.releaseAccount(usedAccount.id)
        recordSuccess(Date.now() - startTime)
      }
      const finishFailure = (error: Error) => {
        if (streamSettled) return
        streamSettled = true
        const finalLatency = Date.now() - startTime
        loadBalancer.releaseAccount(usedAccount.id)
        loadBalancer.markAccountFailed(usedAccount.id)
        proxyStatusManager.recordRequestFailure(finalLatency)
        storeManager.addLog('error', `Completion stream error: ${error.message}`, {
          requestId,
          providerId: usedProvider.id,
          accountId: usedAccount.id,
          model: request.model,
          latency: finalLatency,
        })
      }

      const transformStream = streamHandler.createTransformStream(usedActualModel, requestId)
      result.stream.once('error', finishFailure)
      transformStream.once('error', finishFailure)
      transformStream.once('end', finishSuccess)
      result.stream.pipe(transformStream)
      ctx.body = transformStream
    } else {
      recordSuccess(latency)
      ctx.set('Content-Type', 'application/json')
      ctx.body = result.body
    }
  } catch (error) {
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)

    ctx.status = 500
    ctx.body = {
      error: {
        message: error instanceof Error ? error.message : 'Unknown error',
        type: 'internal_error',
      },
    }
  }
})

export default router
