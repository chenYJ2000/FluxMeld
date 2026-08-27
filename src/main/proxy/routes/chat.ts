/**
 * Proxy Service Module - Chat Completions Route
 * Implements /v1/chat/completions route
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { PassThrough } from 'stream'
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ForwardResult,
  ProxyContext,
} from '../types'
import { loadBalancer } from '../loadbalancer'
import { requestForwarder } from '../forwarder'
import { streamHandler } from '../stream'
import { proxyStatusManager } from '../status'
import { modelMapper } from '../modelMapper'
import { getModelDeprecation } from '../modelDeprecations'
import { storeManager } from '../../store/store'
import {
  isAnthropicToolFormat,
  transformResponseToAnthropic,
  transformChunkToAnthropic
} from '../utils/toolFormatConverter'
import {
  ClientDisconnectedError,
  createRequestDeadline,
  createTimeoutErrorPayload,
  RequestTimeoutError,
  waitForAbort,
} from '../requestLifecycle'
import { getEffectiveRequestTimeout } from '../requestTimeoutPolicy'
import sessionManager from '../sessionManager'
import {
  assistantMessageFromResponse,
  assistantMessageFromSSE,
} from '../services/sessionContextService'

const router = new Router({ prefix: '/v1/chat' })
const SESSION_ID_HEADER = 'x-fluxmeld-session-id'
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/**
 * Generate Request ID
 */
function generateRequestId(): string {
  return `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Get Client IP
 */
function getClientIP(ctx: Context): string {
  return ctx.headers['x-real-ip'] as string ||
    ctx.headers['x-forwarded-for'] as string ||
    ctx.ip ||
    'unknown'
}

function normalizeSessionId(value: unknown, source: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`${source} must be a string`)
  }

  const sessionId = value.trim()
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `${source} must be 1-128 characters and contain only letters, numbers, '.', '_', ':', or '-'`,
    )
  }

  return sessionId
}

/**
 * Resolve the opt-in local-session identifier without forwarding this custom
 * FluxMeld field to an upstream OpenAI-compatible provider.
 */
function getRequestedSessionId(ctx: Context, request: ChatCompletionRequest): string | undefined {
  const requestWithExtensions = request as ChatCompletionRequest & {
    session_id?: unknown
    sessionId?: unknown
  }
  const bodySessionId = normalizeSessionId(
    requestWithExtensions.session_id ?? requestWithExtensions.sessionId,
    'session_id',
  )
  const rawHeader = ctx.headers[SESSION_ID_HEADER]
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader
  const headerSessionId = normalizeSessionId(headerValue, 'X-FluxMeld-Session-Id')

  if (bodySessionId && headerSessionId && bodySessionId !== headerSessionId) {
    throw new Error('session_id and X-FluxMeld-Session-Id must match when both are provided')
  }

  return bodySessionId ?? headerSessionId
}

function withoutLocalSessionFields(request: ChatCompletionRequest): ChatCompletionRequest {
  const { session_id: _sessionId, sessionId: _camelCaseSessionId, ...forwardRequest } = request
  return forwardRequest
}

/**
 * Extract user input from messages (last user message, full content)
 */
function extractUserInput(messages: Array<{ role: string; content?: string | any[] | null }>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user' && msg.content) {
      let content = ''
      if (typeof msg.content === 'string') {
        content = msg.content
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((p: any) => p.type === 'text')
        if (textParts.length > 0) {
          content = textParts.map((p: any) => p.text || '').join(' ')
        }
      }
      if (content) {
        return content
      }
    }
  }
  return undefined
}

function getToolRepairLogFields(result?: ForwardResult) {
  const telemetry = result?.toolRepair
  const formatFieldTypes = (
    issues: NonNullable<ForwardResult['toolRepair']>['firstValidationIssues'],
  ) => issues.map((issue) => ({
    json_pointer: issue.jsonPointer,
    expected: issue.expected,
    actual_type: issue.actualType,
    keyword: issue.keyword,
  }))

  return {
    repair_attempted: telemetry?.attempted ?? false,
    repair_attempts: telemetry?.attempts ?? 0,
    repair_result: telemetry?.result ?? 'not_attempted' as const,
    ...(telemetry ? {
      first_validation_error: telemetry.firstValidationErrors[0],
      final_validation_error: telemetry.finalValidationErrors[0],
      first_field_types: formatFieldTypes(telemetry.firstValidationIssues),
      final_field_types: formatFieldTypes(telemetry.finalValidationIssues),
    } : {}),
  }
}

/**
 * Handle Chat Completions Request
 */
router.post('/completions', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = generateRequestId()
  const clientIP = getClientIP(ctx)
  ctx.set('X-Request-Id', requestId)

  let request: ChatCompletionRequest
  try {
    request = ctx.request.body as ChatCompletionRequest
  } catch (error) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Invalid request body',
        type: 'invalid_request_error',
        param: null,
        code: null,
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
        code: null,
      },
    }
    return
  }

  if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: messages',
        type: 'invalid_request_error',
        param: 'messages',
        code: null,
      },
    }
    return
  }

  let requestedSessionId: string | undefined
  try {
    requestedSessionId = getRequestedSessionId(ctx, request)
  } catch (error) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: error instanceof Error ? error.message : 'Invalid session_id',
        type: 'invalid_request_error',
        param: 'session_id',
        code: 'invalid_session_id',
      },
    }
    return
  }

  // Read feature parameters from Headers (lower priority than request body)
  const webSearchFromHeader = ctx.headers['x-web-search'] === 'true'
  const reasoningEffortFromHeader = ctx.headers['x-reasoning-effort'] as 'low' | 'medium' | 'high' | undefined
  const deepResearchFromHeader = ctx.headers['x-deep-research'] === 'true'

  // Handle reasoningEffort (camelCase) from AI SDK - convert to reasoning_effort (snake_case)
  const requestAny = request as any
  if (requestAny.reasoningEffort && !request.reasoning_effort) {
    request.reasoning_effort = requestAny.reasoningEffort
    console.log('[Chat] Reasoning effort set via reasoningEffort (camelCase):', requestAny.reasoningEffort)
    delete requestAny.reasoningEffort
  }

  // Merge into request (request body parameters take priority)
  if (webSearchFromHeader && request.web_search === undefined) {
    request.web_search = true
    console.log('[Chat] Web search enabled via X-Web-Search header')
  }
  if (reasoningEffortFromHeader && request.reasoning_effort === undefined) {
    request.reasoning_effort = reasoningEffortFromHeader
    console.log('[Chat] Reasoning effort set via X-Reasoning-Effort header:', reasoningEffortFromHeader)
  }
  if (deepResearchFromHeader && request.deep_research === undefined) {
    request.deep_research = true
    console.log('[Chat] Deep research enabled via X-Deep-Research header')
  }

  const config = storeManager.getConfig()
  const requestTimeoutMs = getEffectiveRequestTimeout(
    request,
    config.toolCallingConfig?.clientAdapterId,
    config.requestTimeout,
  )
  const preferredProviderId = modelMapper.getPreferredProvider(request.model)
  const preferredAccountId = modelMapper.getPreferredAccount(request.model)

  const selection = loadBalancer.selectAccount(
    request.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId
  )

  if (!selection) {
    const hasExplicitMapping = Object.keys(config.modelMappings || {})
      .some((model) => model.toLowerCase() === request.model.toLowerCase())
    const deprecation = hasExplicitMapping ? undefined : getModelDeprecation(request.model)
    ctx.status = deprecation ? 410 : 503
    ctx.body = {
      error: {
        message: deprecation?.message || `No available account for model: ${request.model}`,
        type: deprecation ? 'invalid_request_error' : 'service_unavailable_error',
        param: null,
        code: deprecation ? 'model_deprecated' : 'no_available_account',
        ...(deprecation ? {
          details: {
            deprecated_model: deprecation.model,
            suggested_replacement: deprecation.replacement,
            requires_explicit_mapping: true,
          },
        } : {}),
      },
    }
    return
  }

  const { account, provider, actualModel } = selection

  let forwardRequest = withoutLocalSessionFields(request)
  if (requestedSessionId) {
    try {
      const preparedSession = sessionManager.prepareSessionMessages(
        {
          sessionId: requestedSessionId,
          providerId: provider.id,
          accountId: account.id,
          model: request.model,
        },
        request.messages,
      )
      forwardRequest = {
        ...forwardRequest,
        messages: preparedSession.messages,
      }
      ctx.set('X-FluxMeld-Session-Id', preparedSession.sessionId)
    } catch (error) {
      ctx.status = 500
      ctx.body = {
        error: {
          message: error instanceof Error ? error.message : 'Failed to initialize session',
          type: 'api_error',
          param: null,
          code: 'session_initialization_failed',
        },
      }
      return
    }
  }

  const context: ProxyContext = {
    requestId,
    ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
    providerId: provider.id,
    accountId: account.id,
    model: request.model,
    actualModel,
    startTime,
    isStream: request.stream || false,
    clientIP,
  }

  const clientAbortController = new AbortController()
  const abortForClientDisconnect = () => {
    if (!clientAbortController.signal.aborted) {
      clientAbortController.abort(new ClientDisconnectedError(requestId))
    }
  }
  const onResponseClose = () => {
    if (!ctx.res.writableEnded) abortForClientDisconnect()
  }
  ctx.req.once('aborted', abortForClientDisconnect)
  ctx.res.once('close', onResponseClose)

  const requestDeadline = createRequestDeadline({
    requestId,
    timeoutMs: requestTimeoutMs,
    parentSignal: clientAbortController.signal,
    startedAt: startTime,
  })
  const requestContext: ProxyContext = {
    ...context,
    signal: requestDeadline.signal,
    deadlineAt: requestDeadline.deadlineAt,
    timeoutMs: requestTimeoutMs,
  }

  proxyStatusManager.recordRequestStart(request.model, provider.id, account.id)

  try {
    const result = await waitForAbort(
      requestForwarder.forwardChatCompletion(
        forwardRequest,
        account,
        provider,
        actualModel,
        requestContext,
      ),
      requestDeadline.signal,
    )

    const latency = Date.now() - startTime
    const resolvedSelection = result.selection ?? selection
    const usedAccount = resolvedSelection.account
    const usedProvider = resolvedSelection.provider
    const usedActualModel = resolvedSelection.actualModel

    if (!result.success) {
      proxyStatusManager.recordRequestFailure(latency)

      const toolDiagnostics = config.toolCallingConfig.diagnosticsEnabled
        ? result.toolCallingFailure?.diagnostics
        : undefined
      const isTimeout = result.status === 504
      const errorPayload = isTimeout
        ? createTimeoutErrorPayload(result.error || 'Request timed out', requestId)
        : {
            error: {
              message: result.error || 'Request failed',
              type: 'api_error',
              param: null,
              code: result.toolCallingFailure?.code ?? null,
              ...(toolDiagnostics ? { diagnostics: toolDiagnostics } : {}),
            },
          }

      ctx.status = result.status || 500
      ctx.body = errorPayload

      storeManager.addLog('error', `Request failed: ${result.error}`, {
        requestId,
        providerId: usedProvider.id,
        accountId: usedAccount.id,
        model: request.model,
        latency,
        data: {
          ...getToolRepairLogFields(result),
          ...(toolDiagnostics ? { toolCalling: toolDiagnostics } : {}),
        },
      })

      const userInput = extractUserInput(request.messages)
      const errorResponseBody = JSON.stringify(errorPayload)
      storeManager.addRequestLog({
        timestamp: startTime,
        status: 'error',
        statusCode: result.status || 500,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel: usedActualModel,
        providerId: usedProvider.id,
        providerName: usedProvider.name,
        accountId: usedAccount.id,
        accountName: usedAccount.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        ...getToolRepairLogFields(result),
        responseStatus: result.status || 500,
        responseBody: errorResponseBody,
        latency,
        isStream: request.stream || false,
        errorMessage: result.error,
      })

      storeManager.recordRequestInStats(
        false,
        latency,
        request.model,
        usedProvider.id,
        usedAccount.id,
      )

      return
    }

    const userInput = extractUserInput(request.messages)
    const persistSuccessfulSession = (assistantMessage?: ChatMessage) => {
      if (!requestContext.sessionId || !result.contextMessages) return

      try {
        const persistedSession = sessionManager.persistSessionContext({
          sessionId: requestContext.sessionId,
          providerId: usedProvider.id,
          accountId: usedAccount.id,
          model: request.model,
          messages: result.contextMessages,
          ...(assistantMessage ? { assistantMessage } : {}),
          ...(result.providerSessionId ? { providerSessionId: result.providerSessionId } : {}),
        })

        if (!persistedSession) {
          console.warn('[Chat] Session disappeared before its context could be persisted:', requestContext.sessionId)
        }
      } catch (error) {
        // A local persistence failure should never turn a successful provider
        // response into a failed API request.
        console.error('[Chat] Failed to persist session context:', error)
      }
    }

    const recordSuccessfulAccountUse = () => {
      const latestAccount = storeManager.getAccountById(usedAccount.id) ?? usedAccount
      storeManager.updateAccount(usedAccount.id, {
        lastUsed: Date.now(),
        requestCount: (latestAccount.requestCount || 0) + 1,
        todayUsed: (latestAccount.todayUsed || 0) + 1,
      })
    }

    if (request.stream === true && result.stream) {
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      const wrapperStream = new PassThrough()
      let collectedContent = ''
      let streamSettled = false

      const logEntry = storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: 200,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel: usedActualModel,
        providerId: usedProvider.id,
        providerName: usedProvider.name,
        accountId: usedAccount.id,
        accountName: usedAccount.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        ...getToolRepairLogFields(result),
        responseStatus: 200,
        latency,
        isStream: true,
      })

      const finishStreamSuccess = () => {
        if (streamSettled) return
        streamSettled = true
        const finalLatency = Date.now() - startTime

        loadBalancer.releaseAccount(usedAccount.id)
        persistSuccessfulSession(assistantMessageFromSSE(collectedContent))

        loadBalancer.clearAccountFailure(usedAccount.id)
        proxyStatusManager.recordRequestSuccess(finalLatency)
        recordSuccessfulAccountUse()
        storeManager.recordRequestInStats(
          true,
          finalLatency,
          request.model,
          usedProvider.id,
          usedAccount.id,
        )
        storeManager.updateRequestLog(logEntry.id, {
          status: 'success',
          statusCode: 200,
          responseStatus: 200,
          responseBody: collectedContent || undefined,
          latency: finalLatency,
          errorMessage: undefined,
        })
        storeManager.addLog('debug', 'Stream response completed', {
          requestId,
          providerId: usedProvider.id,
          accountId: usedAccount.id,
          model: request.model,
          actualModel: usedActualModel,
          latency: finalLatency,
          isStream: true,
          data: getToolRepairLogFields(result),
        })
      }

      const finishStreamFailure = (err: Error, sendToClient: boolean = true) => {
        if (streamSettled) return
        streamSettled = true
        const finalLatency = Date.now() - startTime
        const statusCode = 502

        loadBalancer.releaseAccount(usedAccount.id)
        loadBalancer.markAccountFailed(usedAccount.id)
        proxyStatusManager.recordRequestFailure(finalLatency)
        storeManager.recordRequestInStats(
          false,
          finalLatency,
          request.model,
          usedProvider.id,
          usedAccount.id,
        )

        const errorEvent = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: usedActualModel,
          choices: [{
            index: 0,
            delta: {
              content: `\n\n[Error: ${err.message}]`,
            },
            finish_reason: 'stop',
          }],
        }

        const serializedError = `data: ${JSON.stringify(errorEvent)}\n\ndata: [DONE]\n\n`
        collectedContent += serializedError
        storeManager.updateRequestLog(logEntry.id, {
          status: 'error',
          statusCode,
          responseStatus: statusCode,
          responseBody: collectedContent,
          latency: finalLatency,
          errorMessage: err.message,
        })

        storeManager.addLog('error', `Stream error: ${err.message}`, {
          requestId,
          providerId: usedProvider.id,
          accountId: usedAccount.id,
          model: request.model,
          latency: finalLatency,
          data: getToolRepairLogFields(result),
        })

        if (sendToClient && !wrapperStream.destroyed && !wrapperStream.writableEnded) {
          wrapperStream.end(serializedError)
        }
      }

      result.stream.once('error', (err: Error) => {
        console.error('[Chat] Stream error:', err.message)
        finishStreamFailure(err)
      })

      if (result.skipTransform) {
        result.stream.on('data', (chunk: Buffer) => {
          collectedContent += chunk.toString()
        })

        result.stream.pipe(wrapperStream, { end: false })
        result.stream.once('end', () => {
          finishStreamSuccess()
          wrapperStream.end()
        })
      } else {
        const transformStream = streamHandler.createTransformStream(
          usedActualModel,
          requestId,
        )

        transformStream.on('data', (chunk: Buffer) => {
          collectedContent += chunk.toString()
        })
        transformStream.once('error', (err: Error) => finishStreamFailure(err))

        result.stream.pipe(transformStream)
        transformStream.pipe(wrapperStream, { end: false })

        transformStream.once('end', () => {
          finishStreamSuccess()
          wrapperStream.end()
        })
      }

      wrapperStream.once('close', () => {
        if (streamSettled) return
        const upstreamStream = result.stream as (NodeJS.ReadableStream & { destroy?: () => void })
        if (typeof upstreamStream.destroy === 'function') upstreamStream.destroy()
        finishStreamFailure(new Error('Client disconnected before stream completion'), false)
      })

      ctx.body = wrapperStream
    } else {
      ctx.set('Content-Type', 'application/json')

      let responseBody: ChatCompletionResponse | unknown
      if (result.body) {
        if (isAnthropicToolFormat(request.tool_format)) {
          responseBody = transformResponseToAnthropic(result.body)
          console.log('[Chat] Transformed response to Anthropic tool format')
        } else {
          responseBody = result.body
        }
      } else {
        responseBody = {
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: usedActualModel,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
            },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        }
      }

      loadBalancer.clearAccountFailure(usedAccount.id)
      persistSuccessfulSession(assistantMessageFromResponse(result.body))
      proxyStatusManager.recordRequestSuccess(latency)
      recordSuccessfulAccountUse()
      storeManager.recordRequestInStats(
        true,
        latency,
        request.model,
        usedProvider.id,
        usedAccount.id,
      )
      storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: 200,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel: usedActualModel,
        providerId: usedProvider.id,
        providerName: usedProvider.name,
        accountId: usedAccount.id,
        accountName: usedAccount.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        ...getToolRepairLogFields(result),
        responseStatus: 200,
        responseBody: JSON.stringify(responseBody),
        latency,
        isStream: false,
      })
      storeManager.addLog('debug', 'Request succeeded', {
        requestId,
        providerId: usedProvider.id,
        accountId: usedAccount.id,
        model: request.model,
        actualModel: usedActualModel,
        latency,
        isStream: false,
        data: getToolRepairLogFields(result),
      })
      ctx.body = responseBody
    }
  } catch (error) {
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const isTimeout = error instanceof RequestTimeoutError
    const isClientDisconnect = error instanceof ClientDisconnectedError
    const statusCode = isTimeout ? 504 : isClientDisconnect ? 499 : 500
    const errorType = isTimeout
      ? 'timeout_error'
      : isClientDisconnect
        ? 'client_disconnected_error'
        : 'internal_error'
    const errorCode = isTimeout
      ? 'request_timeout'
      : isClientDisconnect
        ? 'client_disconnected'
        : null
    const errorStack = !isTimeout && !isClientDisconnect && error instanceof Error
      ? error.stack
      : undefined
    const exceptionPayload = isTimeout
      ? createTimeoutErrorPayload(errorMessage, requestId)
      : {
          error: {
            message: errorMessage,
            type: errorType,
            param: null,
            code: errorCode,
          },
        }

    if (!isClientDisconnect) {
      ctx.status = statusCode
      ctx.body = exceptionPayload
    }

    storeManager.addLog(isClientDisconnect ? 'warn' : 'error', `Request exception: ${errorMessage}`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      latency,
      error: errorMessage,
      data: getToolRepairLogFields(),
    })

    const userInput = extractUserInput(request.messages)
    const exceptionResponseBody = isClientDisconnect ? undefined : JSON.stringify(exceptionPayload)
    storeManager.addRequestLog({
      timestamp: startTime,
      status: 'error',
      statusCode,
      method: 'POST',
      url: '/v1/chat/completions',
      model: request.model,
      actualModel,
      providerId: provider.id,
      providerName: provider.name,
      accountId: account.id,
      accountName: account.name,
      requestBody: JSON.stringify(request),
      userInput,
      webSearch: request.web_search,
      reasoningEffort: request.reasoning_effort,
      ...getToolRepairLogFields(),
      responseStatus: statusCode,
      responseBody: exceptionResponseBody,
      latency,
      isStream: request.stream || false,
      errorMessage,
      errorStack,
    })

    storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id)
  } finally {
    requestDeadline.dispose()
    ctx.req.removeListener('aborted', abortForClientDisconnect)
    ctx.res.removeListener('close', onResponseClose)
  }
})

export default router
