import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldRouteThroughProxy } from '../../src/main/proxy/forwarder.ts'
import { filterRealClashNodes } from '../../src/main/proxy/outboundProxy.ts'

test('network-level failures (no status) trigger proxy routing', () => {
  assert.equal(shouldRouteThroughProxy(undefined), true)
  assert.equal(shouldRouteThroughProxy(undefined, 'ECONNREFUSED'), true)
})

test('rate limit and block status codes trigger proxy routing', () => {
  assert.equal(shouldRouteThroughProxy(403), true)
  assert.equal(shouldRouteThroughProxy(408), true)
  assert.equal(shouldRouteThroughProxy(409), true)
  assert.equal(shouldRouteThroughProxy(425), true)
  assert.equal(shouldRouteThroughProxy(429), true)
})

test('server errors trigger proxy routing', () => {
  assert.equal(shouldRouteThroughProxy(500), true)
  assert.equal(shouldRouteThroughProxy(502), true)
  assert.equal(shouldRouteThroughProxy(503), true)
})

test('authentication failures do NOT trigger proxy routing', () => {
  assert.equal(shouldRouteThroughProxy(401), false)
})

test('other client errors do NOT trigger proxy routing', () => {
  assert.equal(shouldRouteThroughProxy(400), false)
  assert.equal(shouldRouteThroughProxy(404), false)
  assert.equal(shouldRouteThroughProxy(422), false)
})

test('filterRealClashNodes keeps real nodes and drops policy groups', () => {
  const proxies = {
    DIRECT: { type: 'Direct' },
    REJECT: { type: 'Reject' },
    'REJECT-DROP': { type: 'RejectDrop' },
    '节点选择': { type: 'Selector' },
    '自动选择': { type: 'URLTest' },
    '剩余流量：40.37 GB': { type: 'Vmess' },
    '套餐到期：长期有效': { type: 'Vmess' },
    '日本JP-HY2': { type: 'Hysteria2' },
    '新加坡-优化2-Gemini-GPT': { type: 'Vmess' },
    COMPATIBLE: { type: 'Compatible' },
    PASS: { type: 'Pass' },
  }
  const nodes = filterRealClashNodes(proxies)
  assert.equal(nodes.length, 2)
  assert.ok(nodes.includes('日本JP-HY2'))
  assert.ok(nodes.includes('新加坡-优化2-Gemini-GPT'))
})

test('filterRealClashNodes tolerates empty and missing payloads', () => {
  assert.deepEqual(filterRealClashNodes({}), [])
  assert.deepEqual(filterRealClashNodes({ foo: {} }), [])
})

test('filterRealClashNodes ranks alive nodes first but keeps dead ones eligible', () => {
  const proxies = {
    '美国-慢在线': { type: 'Vmess', alive: true, history: [{ delay: 500 }] },
    '美国-快在线': { type: 'Vmess', alive: true, history: [{ delay: 100 }] },
    '美国-已死（可能复活）': { type: 'Vmess', alive: false },
    '日本-未知状态': { type: 'Vmess' },
  }
  const nodes = filterRealClashNodes(proxies)
  // Dead node stays in the pool so it can be used again after recovery,
  // but alive nodes sort before it.
  assert.ok(nodes.includes('美国-已死（可能复活）'))
  assert.equal(nodes[0], '美国-快在线')
  const deadIndex = nodes.indexOf('美国-已死（可能复活）')
  const aliveSlowIndex = nodes.indexOf('美国-慢在线')
  assert.ok(deadIndex > aliveSlowIndex, 'dead node ranks after alive nodes')
})