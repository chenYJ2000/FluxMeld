import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { KimiStreamHandler } from '../../src/main/proxy/adapters/kimi'

function frame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(5)
  header.writeUInt8(0, 0)
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}

test('Kimi ignores done=false frames and waits for the final done=true frame', async () => {
  const upstream = new PassThrough()
  const handler = new KimiStreamHandler('Kimi-K3', 'conversation-test')
  const responsePromise = handler.handleNonStream(upstream)

  upstream.write(frame({ done: false }))
  upstream.write(
    frame({
      op: 'append',
      mask: 'block.text',
      block: { text: { content: 'OK' } },
    }),
  )
  upstream.end(frame({ done: true }))

  const response = await responsePromise
  assert.equal(response.choices[0].message.content, 'OK')
  assert.equal(response.choices[0].finish_reason, 'stop')
})

test('Kimi maps structured capacity errors to a safe HTTP 429 error', async () => {
  const upstream = new PassThrough()
  const handler = new KimiStreamHandler('Kimi-K3', 'conversation-test')
  const responsePromise = handler.handleNonStream(upstream)

  upstream.end(
    frame({
      error: {
        code: 'resource_exhausted',
        details: [
          {
            debug: {
              localizedMessage: {
                message: 'The Kimi service is at capacity.',
              },
              secretInternalValue: 'must-not-be-returned',
            },
          },
        ],
      },
    }),
  )

  await assert.rejects(responsePromise, (error: any) => {
    assert.equal(error.status, 429)
    assert.equal(error.message, 'The Kimi service is at capacity.')
    assert.equal(error.message.includes('must-not-be-returned'), false)
    return true
  })
})

test('Kimi maps an invalid user token to HTTP 401 without echoing a credential', async () => {
  const upstream = new PassThrough()
  const handler = new KimiStreamHandler('Kimi-K3', 'conversation-test')
  const responsePromise = handler.handleNonStream(upstream)

  upstream.end(frame({ error: 'invalid user token' }))

  await assert.rejects(responsePromise, (error: any) => {
    assert.equal(error.status, 401)
    assert.equal(error.message, 'Kimi API Error: invalid user token')
    return true
  })
})
