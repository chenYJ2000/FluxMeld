import assert from 'node:assert/strict'
import test from 'node:test'
import axios, { AxiosError } from 'axios'
import { createInbox } from '../../src/main/oauth/emailApi.ts'

const restricted = () =>
  new AxiosError('Domain restricted', undefined, undefined, undefined, {
    data: {
      message: 'This shared domain is currently restricted and not accepting new public addresses',
    },
    status: 403,
  } as any)

function config(domain = '') {
  return {
    enabled: true,
    service: 'yyds' as const,
    token: 'fixture',
    baseUrl: 'https://email.example.test',
    domain,
    pollTimeoutMs: 1000,
  }
}

test('automatic restricted domain delegates allocation to email service once', async (t) => {
  t.mock.method(axios, 'get', async () => ({ data: { data: [{ domain: 'closed.example.test' }] } }))
  const bodies: unknown[] = []
  t.mock.method(axios, 'post', async (_url, body) => {
    bodies.push(body)
    if (bodies.length === 1) throw restricted()
    return {
      data: { data: { address: 'fixture@open.example.test', id: 'inbox', token: 'inbox-token' } },
    }
  })
  assert.deepEqual(await createInbox(config()), {
    address: 'fixture@open.example.test',
    id: 'inbox',
    token: 'inbox-token',
  })
  assert.deepEqual(bodies, [{ domain: 'closed.example.test' }, {}])
})

test('explicit restricted domain is reported without changing domains', async (t) => {
  let calls = 0
  t.mock.method(axios, 'post', async () => {
    calls++
    throw restricted()
  })
  await assert.rejects(
    createInbox(config('closed.example.test')),
    /shared domain is currently restricted/,
  )
  assert.equal(calls, 1)
})

test('other authorization failures do not trigger another allocation', async (t) => {
  let calls = 0
  t.mock.method(axios, 'post', async () => {
    calls++
    throw new AxiosError('Unauthorized', undefined, undefined, undefined, {
      data: { message: 'Invalid API key' },
      status: 403,
    } as any)
  })
  await assert.rejects(createInbox(config()), /Invalid API key/)
  assert.equal(calls, 1)
})

test('failed service allocation is reported without an unbounded retry', async (t) => {
  let calls = 0
  t.mock.method(axios, 'post', async () => {
    calls++
    throw restricted()
  })
  await assert.rejects(createInbox(config()), /shared domain is currently restricted/)
  assert.equal(calls, 2)
})
