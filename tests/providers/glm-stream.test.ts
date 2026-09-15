import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough, Readable } from 'node:stream'

import {
  addGLMTransportNonce,
  applyGLMGenerationControls,
  GLMStreamHandler,
  GLMUpstreamResponseError,
} from '../../src/main/providers/glm/adapter.ts'
import {
  ClientDisconnectedError,
  RequestTimeoutError,
} from '../../src/main/proxy/requestLifecycle.ts'

function sse(events: unknown[]): Readable {
  return Readable.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`))
}

test('GLM non-stream resolves only after an explicit finish event', async () => {
  const handler = new GLMStreamHandler('glm-5.2')
  const response = await handler.handleNonStream(
    sse([
      {
        status: 'streaming',
        conversation_id: 'conversation-1',
        parts: [
          {
            logic_id: 'answer-1',
            status: 'finish',
            content: [
              { type: 'think', think: 'reasoning' },
              { type: 'text', text: 'answer' },
            ],
          },
        ],
      },
      { status: 'finish', conversation_id: 'conversation-1' },
    ]),
  )

  assert.equal(response.id, 'conversation-1')
  assert.equal(response.choices[0].message.content, 'answer')
  assert.equal(response.choices[0].message.reasoning_content, 'reasoning')
})

test('GLM intervene frames are failures, never successful cached responses', async () => {
  const handler = new GLMStreamHandler('glm-5.2')

  await assert.rejects(
    handler.handleNonStream(
      sse([
        {
          status: 'intervene',
          last_error: { intervene_text: 'request rejected' },
        },
      ]),
    ),
    (error: unknown) =>
      error instanceof GLMUpstreamResponseError &&
      error.status === 502 &&
      /request rejected/.test(error.message),
  )
})

test('GLM early stream end rejects instead of returning an empty 200 response', async () => {
  const upstream = new PassThrough()
  const handler = new GLMStreamHandler('glm-5.2')
  const responsePromise = handler.handleNonStream(upstream)

  upstream.end('data: {"status":"streaming"}\n\n')

  await assert.rejects(responsePromise, /ended before a finish event/)
})

test('GLM non-stream hard timeout rejects and destroys an upstream that never settles', async () => {
  const upstream = new PassThrough()
  const handler = new GLMStreamHandler('glm-5.2')

  await assert.rejects(
    handler.handleNonStream(upstream, {
      timeoutMs: 15,
      requestId: 'chatcmpl-timeout-test',
    }),
    (error: unknown) =>
      error instanceof RequestTimeoutError &&
      error.status === 504 &&
      error.code === 'request_timeout' &&
      error.requestId === 'chatcmpl-timeout-test',
  )
  assert.equal(upstream.destroyed, true)
})

test('GLM non-stream propagates client cancellation and destroys the upstream', async () => {
  const upstream = new PassThrough()
  const controller = new AbortController()
  const handler = new GLMStreamHandler('glm-5.2')
  const responsePromise = handler.handleNonStream(upstream, {
    signal: controller.signal,
    timeoutMs: 1000,
    requestId: 'chatcmpl-client-abort-test',
  })
  const disconnect = new ClientDisconnectedError('chatcmpl-client-abort-test')

  controller.abort(disconnect)

  await assert.rejects(responsePromise, (error: unknown) => error === disconnect)
  assert.equal(upstream.destroyed, true)
})

test('GLM transport nonce varies identical requests without mutating their prompt', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'same prompt' }] }]
  const first = addGLMTransportNonce(messages, 'request-a')
  const second = addGLMTransportNonce(messages, 'request-b')

  assert.equal(messages[0].content[0].text, 'same prompt')
  assert.match(first[0].content[0].text, /request-a/)
  assert.match(second[0].content[0].text, /request-b/)
  assert.notEqual(first[0].content[0].text, second[0].content[0].text)
})

test('GLM deterministic repair controls send temperature zero and disable sampling immutably', () => {
  const payload = { assistant_id: 'assistant', messages: [] }
  const controlled = applyGLMGenerationControls(payload, 0)

  assert.deepEqual(controlled, {
    assistant_id: 'assistant',
    messages: [],
    temperature: 0,
    do_sample: false,
  })
  assert.deepEqual(payload, { assistant_id: 'assistant', messages: [] })
  assert.throws(
    () => applyGLMGenerationControls(payload, 1.1),
    /temperature must be a finite number between 0 and 1/,
  )
})
