import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'

import {
  DoubaoAdapter,
  DoubaoStreamHandler,
  DoubaoLimitedError,
} from '../../src/main/providers/doubao/adapter.ts'
import { doubaoModule } from '../../src/main/providers/doubao/index.ts'

function frame(eventType: number, eventData: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    event_type: eventType,
    event_data: JSON.stringify(eventData),
  })}\n\n`
}

const start = (ids: Record<string, string>) => frame(2002, ids)
const text = (value: string) =>
  frame(2001, { message: { content_type: 2001, content: JSON.stringify({ text: value }) } })
const end = () => frame(2003, {})

test('Doubao non-stream concatenates text fragments and reports the conversation id', async () => {
  const handler = new DoubaoStreamHandler('doubao')
  const response = await handler.handleNonStream(
    Readable.from([
      start({ conversation_id: 'c1', message_id: 'm1', section_id: 's1' }),
      text('Hello'),
      text(' world'),
      end(),
    ]),
  )

  assert.equal(response.id, 'c1')
  assert.equal(response.choices[0].message.content, 'Hello world')
  assert.equal(handler.getConversationId(), 'c1')
})

test('Doubao stream emits OpenAI chunks and terminates with [DONE]', async () => {
  const handler = new DoubaoStreamHandler('doubao')
  const stream = await handler.handleStream(
    Readable.from([start({ conversation_id: 'c2' }), text('streamed'), end()]),
  )

  let output = ''
  for await (const chunk of stream) output += chunk.toString()

  assert.match(output, /"role":"assistant"/)
  assert.match(output, /"content":"streamed"/)
  assert.match(output, /"finish_reason":"stop"/)
  assert.match(output, /data: \[DONE\]/)
})

test('Doubao guest-limit frames surface as a rate-limit error', async () => {
  const handler = new DoubaoStreamHandler('doubao')
  await assert.rejects(
    handler.handleNonStream(Readable.from(['data: tourist conversation reach limited\n\n'])),
    (error: unknown) => error instanceof DoubaoLimitedError,
  )
})

test('Doubao gateway-error frames fail the response', async () => {
  const handler = new DoubaoStreamHandler('doubao')
  await assert.rejects(
    handler.handleNonStream(
      Readable.from(['event: gateway-error\ndata: {"code":"1234","message":"boom"}\n\n']),
    ),
    /网关错误/,
  )
})

test('Doubao handler rejects an already-aborted request without a TDZ error', async () => {
  const handler = new DoubaoStreamHandler('doubao')
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    handler.handleNonStream(Readable.from([]), { signal: controller.signal }),
    (error: unknown) => !(error instanceof ReferenceError),
  )
})

test('Doubao module declares the samantha session credentials', () => {
  assert.equal(doubaoModule.id, 'doubao')
  assert.equal(doubaoModule.config.id, 'doubao')
  assert.ok(doubaoModule.config.apiEndpoint.includes('doubao.com'))
  assert.equal(doubaoModule.config.chatPath, '/samantha/chat/completion')

  const names = (doubaoModule.config.credentialFields ?? []).map((field) => field.name)
  assert.deepEqual(names, ['cookies', 'device_id', 'tea_uuid', 'web_id', 'room_id', 'x_flow_trace'])

  // room_id is optional (it only feeds the Referer), so it is never "missing".
  const required = ['cookies', 'device_id', 'tea_uuid', 'web_id', 'x_flow_trace']
  assert.deepEqual(DoubaoAdapter.missingCredentials({}), required)
  assert.deepEqual(DoubaoAdapter.missingCredentials({ cookies: 'a=1' }), required.slice(1))
})

test('Doubao declares an assisted in-app login that captures the samantha session', () => {
  const extraction = doubaoModule.tokenExtraction
  assert.ok(extraction, 'tokenExtraction must be declared')
  assert.equal(extraction!.collectCookies, true)
  assert.deepEqual(extraction!.requiredKeys, [
    'cookies',
    'device_id',
    'tea_uuid',
    'web_id',
    'x_flow_trace',
  ])

  const byKey = new Map(extraction!.tokenSources.map((source) => [source.key, source]))
  assert.equal(byKey.get('device_id')?.type, 'queryParam')
  assert.equal(byKey.get('tea_uuid')?.type, 'queryParam')
  assert.equal(byKey.get('web_id')?.type, 'queryParam')
  assert.equal(byKey.get('x_flow_trace')?.type, 'networkHeader')
  assert.equal(byKey.get('x_flow_trace')?.header, 'x-flow-trace')
  assert.equal(byKey.get('room_id')?.type, 'urlPath')
})
