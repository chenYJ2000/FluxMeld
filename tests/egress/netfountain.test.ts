import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NetFountainClient,
  parseNetFountainRecord,
  type NetFountainHttpFn,
  type NetFountainResponse,
} from '../../src/main/egress/netfountain/client.ts'
import { NetFountainSource } from '../../src/main/egress/netfountain/source.ts'
import type { EgressServices } from '../../src/main/egress/types.ts'

type Handler = (method: string, url: string) => NetFountainResponse | Promise<NetFountainResponse>

function ok(data: unknown): NetFountainResponse {
  return { status: 200, data: { code: 0, msg: 'ok', data } }
}

function fail(code: number, msg = 'error'): NetFountainResponse {
  return { status: 200, data: { code, msg, data: null } }
}

function poolRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 3,
    ip: '1.2.3.4',
    port: 8080,
    protocol: 'http',
    proxy_url: 'http://1.2.3.4:8080',
    latency_ms: 350,
    leased: true,
    ttl: 120,
    created_at: 1000,
    ...overrides,
  }
}

function makeClient(handler: Handler): {
  client: NetFountainClient
  calls: Array<{ method: string; url: string }>
} {
  const calls: Array<{ method: string; url: string }> = []
  const http: NetFountainHttpFn = async ({ method, url }) => {
    calls.push({ method, url })
    return handler(method, url)
  }
  const client = new NetFountainClient({
    baseUrl: 'http://pool:9000/api/v1/',
    site: 'glm',
    http,
  })
  return { client, calls }
}

const SETTINGS = {
  baseUrl: 'http://pool:9000/api/v1',
  site: 'glm',
  minRemainingSeconds: 120,
  emptyPoolWaitMs: 1,
}

function makeServices(settings: Record<string, unknown> = SETTINGS): EgressServices {
  return {
    getSettings: () => settings,
    rotation: {
      strategy: 'roundRobin',
      rotateEarlySeconds: 30,
      verifyBeforeUse: false,
      verifyTimeoutMs: 2000,
      maxExitAttempts: 0,
      rotateMinIntervalMs: 3000,
      cooldownBaseMs: 1000,
      cooldownMaxMs: 30000,
    },
    logger: { info: () => {}, warn: () => {} },
  }
}

function makeSource(handler: Handler, settings: Record<string, unknown> = SETTINGS) {
  const { client, calls } = makeClient(handler)
  const source = new NetFountainSource(makeServices(settings), { client })
  return { source, calls }
}

test('parseNetFountainRecord normalizes fields and derives proxy_url', () => {
  const parsed = parseNetFountainRecord({
    id: '7',
    ip: '5.6.7.8',
    port: '1080',
    protocol: 'SOCKS5',
    ttl: 60,
    created_at: 2000,
    leased: true,
  })
  assert.equal(parsed?.id, 7)
  assert.equal(parsed?.port, 1080)
  assert.equal(parsed?.protocol, 'socks5')
  assert.equal(parsed?.proxy_url, 'socks5://5.6.7.8:1080')
  assert.equal(parsed?.ttl, 60)
  assert.equal(parsed?.created_at, 2000)
})

test('parseNetFountainRecord rejects malformed entries', () => {
  assert.equal(parseNetFountainRecord(null), null)
  assert.equal(parseNetFountainRecord({ ip: '', port: 1 }), null)
  assert.equal(parseNetFountainRecord({ id: 1, ip: 'a', port: 0 }), null)
  assert.equal(parseNetFountainRecord({ id: -1, ip: 'a', port: 80 }), null)
  assert.equal(parseNetFountainRecord({ id: 1, ip: 'a', port: 70000 }), null)
})

test('acquire requests remaining_desc with a min remaining floor', async () => {
  const { client, calls } = makeClient(() => ok(poolRecord()))
  const result = await client.acquire(120)
  assert.equal(result.status, 'ok')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.equal(
    calls[0].url,
    'http://pool:9000/api/v1/glm/ips/acquire?strategy=remaining_desc&min_remaining_sec=120',
  )
})

test('acquire classifies empty-pool and configuration errors', async () => {
  const empty = makeClient(() => fail(40402, 'empty pool: no free ip available'))
  assert.equal((await empty.client.acquire(120)).status, 'empty')

  const config = makeClient(() => fail(40400, 'site not configured'))
  assert.equal((await config.client.acquire(120)).status, 'config-error')

  const invalid = makeClient(() => fail(40000, 'bad param'))
  assert.equal((await invalid.client.acquire(120)).status, 'config-error')

  const other = makeClient(() => fail(50200, 'upstream error'))
  assert.equal((await other.client.acquire(120)).status, 'error')
})

test('count and record management use the expected endpoints', async () => {
  const { client, calls } = makeClient((_method, url) =>
    url.endsWith('/count') ? ok({ total: 5, free_total: 2 }) : ok(true),
  )
  const count = await client.count()
  assert.equal(count?.free_total, 2)
  assert.equal(await client.remove(3), true)
  assert.equal(await client.release(4), true)
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    [
      'GET http://pool:9000/api/v1/glm/count',
      'DELETE http://pool:9000/api/v1/glm/ips/3',
      'POST http://pool:9000/api/v1/glm/ips/4/release',
    ],
  )
})

test('source leases an exit and maps ttl to expiresAt', async () => {
  const { source } = makeSource(() => ok(poolRecord({ ttl: 120, created_at: 1000 })))
  const exit = await source.acquireExit()
  assert.equal(exit?.id, '3')
  assert.equal(exit?.host, '1.2.3.4')
  assert.equal(exit?.protocol, 'http')
  assert.equal(exit?.expiresAt, (1000 + 120) * 1000)
  assert.equal((await source.listExits()).length, 1)
})

test('source leaves expiresAt unset when ttl is null', async () => {
  const { source } = makeSource(() => ok(poolRecord({ ttl: null })))
  const exit = await source.acquireExit()
  assert.equal(exit?.expiresAt, undefined)
})

test('source deletes and re-acquires unsupported protocols', async () => {
  let acquired = 0
  const { source, calls } = makeSource((method, url) => {
    if (method === 'POST' && url.includes('/ips/acquire')) {
      acquired += 1
      return acquired === 1
        ? ok(poolRecord({ protocol: 'socks4', proxy_url: 'socks4://1.2.3.4:8080' }))
        : ok(poolRecord({ id: 9 }))
    }
    return ok(true)
  })

  const exit = await source.acquireExit()
  assert.equal(exit?.id, '9')
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/ips/3')))
  assert.equal(acquired, 2)
})

test('source waits and retries when the pool is empty', async () => {
  let acquireCalls = 0
  const { source } = makeSource((method, url) => {
    if (url.includes('/ips/acquire')) {
      acquireCalls += 1
      return acquireCalls === 1 ? fail(40402, 'empty') : ok(poolRecord())
    }
    return ok(true)
  })

  const exit = await source.acquireExit()
  assert.equal(exit?.id, '3')
  assert.equal(acquireCalls, 2)
})

test('source stops waiting when the acquisition is aborted', async () => {
  const controller = new AbortController()
  const { source } = makeSource(() => fail(40402, 'empty'), { ...SETTINGS, emptyPoolWaitMs: 5000 })
  const pending = source.acquireExit(controller.signal)
  setTimeout(() => controller.abort(), 5)
  const exit = await pending
  assert.equal(exit, null)
})

test('disposeExit deletes the leased IP', async () => {
  const { source, calls } = makeSource(() => ok(poolRecord()))
  const exit = await source.acquireExit()
  assert.ok(exit)
  await source.disposeExit(exit)
  assert.equal((await source.listExits()).length, 0)
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/ips/3')))
})

test('deactivate releases every held lease individually', async () => {
  let counter = 0
  const { source, calls } = makeSource((method, url) => {
    if (url.includes('/ips/acquire')) {
      counter += 1
      return ok(poolRecord({ id: counter }))
    }
    return ok(true)
  })

  await source.acquireExit()
  await source.acquireExit()
  await source.deactivate()

  const releases = calls
    .filter((call) => call.method === 'POST' && call.url.includes('/release'))
    .map((call) => call.url)
    .sort()
  assert.deepEqual(releases, [
    'http://pool:9000/api/v1/glm/ips/1/release',
    'http://pool:9000/api/v1/glm/ips/2/release',
  ])
  assert.equal((await source.listExits()).length, 0)
})

test('probe is available while the pool is empty (acquisition waits)', async () => {
  const { source } = makeSource((_method, url) =>
    url.endsWith('/count') ? ok({ total: 0, free_total: 0 }) : ok(poolRecord()),
  )
  const result = await source.probe()
  assert.equal(result.available, true)
  assert.equal(result.details?.freeTotal, 0)
})

test('probe reports unavailable when the gateway is unreachable', async () => {
  const http: NetFountainHttpFn = async () => {
    throw new Error('boom')
  }
  const client = new NetFountainClient({ baseUrl: 'http://pool', site: 'glm', http })
  const source = new NetFountainSource(makeServices(), { client })
  const result = await source.probe()
  assert.equal(result.available, false)
})
