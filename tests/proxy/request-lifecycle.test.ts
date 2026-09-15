import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ClientDisconnectedError,
  createRequestDeadline,
  createTimeoutErrorPayload,
  RequestTimeoutError,
  waitForAbort,
} from '../../src/main/proxy/requestLifecycle.ts'

test('request deadline settles a never-resolving operation with a structured 504 error', async () => {
  const deadline = createRequestDeadline({
    requestId: 'chatcmpl-deadline-test',
    timeoutMs: 15,
  })

  try {
    await assert.rejects(
      waitForAbort(new Promise<never>(() => undefined), deadline.signal),
      (error: unknown) =>
        error instanceof RequestTimeoutError &&
        error.status === 504 &&
        error.code === 'request_timeout' &&
        error.requestId === 'chatcmpl-deadline-test',
    )
  } finally {
    deadline.dispose()
  }
})

test('parent client cancellation propagates through the shared deadline signal', async () => {
  const parent = new AbortController()
  const deadline = createRequestDeadline({
    requestId: 'chatcmpl-disconnect-test',
    timeoutMs: 1000,
    parentSignal: parent.signal,
  })
  const disconnect = new ClientDisconnectedError('chatcmpl-disconnect-test')

  try {
    parent.abort(disconnect)
    await assert.rejects(
      waitForAbort(Promise.resolve('too late'), deadline.signal),
      (error: unknown) => error === disconnect,
    )
  } finally {
    deadline.dispose()
  }
})

test('timeout payload carries the request id in OpenAI-compatible error structure', () => {
  assert.deepEqual(createTimeoutErrorPayload('request timed out after 60000ms', 'chatcmpl-123'), {
    error: {
      message: 'request timed out after 60000ms',
      type: 'timeout_error',
      param: null,
      code: 'request_timeout',
    },
    request_id: 'chatcmpl-123',
  })
})
