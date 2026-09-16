import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldRouteThroughProxy } from '../../src/main/proxy/forwarder.ts'
import { parseClashNodeTable } from '../../src/main/egress/clash/nodes.ts'

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

test('parseClashNodeTable keeps the original order and marks non-selectable entries', () => {
  const proxies = {
    DIRECT: { type: 'Direct' },
    REJECT: { type: 'Reject' },
    'REJECT-DROP': { type: 'RejectDrop' },
    节点选择: { type: 'Selector' },
    自动选择: { type: 'URLTest' },
    '剩余流量：40.37 GB': { type: 'Vmess' },
    '套餐到期：长期有效': { type: 'Vmess' },
    '日本JP-HY2': { type: 'Hysteria2' },
    '新加坡-优化2-Gemini-GPT': { type: 'Vmess' },
    COMPATIBLE: { type: 'Compatible' },
    PASS: { type: 'Pass' },
  }
  const table = parseClashNodeTable(proxies)
  // Every entry is kept so it can consume candidate budget.
  assert.equal(table.length, 11)
  assert.deepEqual(
    table.map((entry) => entry.name),
    Object.keys(proxies),
  )
  const byName = Object.fromEntries(table.map((entry) => [entry.name, entry]))
  assert.equal(byName['日本JP-HY2'].selectable, true)
  assert.equal(byName['新加坡-优化2-Gemini-GPT'].selectable, true)
  assert.equal(byName['节点选择'].selectable, false)
  assert.equal(byName['自动选择'].selectable, false)
  assert.equal(byName.DIRECT.selectable, false)
  assert.equal(byName.REJECT.selectable, false)
  assert.equal(byName['REJECT-DROP'].selectable, false)
  assert.equal(byName['剩余流量：40.37 GB'].selectable, false)
  assert.equal(byName['套餐到期：长期有效'].selectable, false)
  assert.equal(byName.COMPATIBLE.selectable, false)
  assert.equal(byName.PASS.selectable, false)
})

test('parseClashNodeTable tolerates empty and missing payloads', () => {
  assert.deepEqual(parseClashNodeTable({}), [])
  assert.deepEqual(parseClashNodeTable({ foo: {} }), [])
})

test('parseClashNodeTable marks dead nodes without dropping them', () => {
  const proxies = {
    '美国-慢在线': { type: 'Vmess', alive: true, history: [{ delay: 500 }] },
    '美国-已死': { type: 'Vmess', alive: false },
    '日本-未知状态': { type: 'Vmess' },
  }
  const table = parseClashNodeTable(proxies)
  const byName = Object.fromEntries(table.map((entry) => [entry.name, entry]))
  assert.equal(byName['美国-已死'].alive, false)
  assert.equal(byName['美国-已死'].selectable, true)
  assert.equal(byName['美国-慢在线'].alive, true)
  assert.equal(byName['日本-未知状态'].alive, true)
  assert.equal(byName['美国-慢在线'].delay, 500)
})
