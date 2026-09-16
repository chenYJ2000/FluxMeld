import test from 'node:test'
import assert from 'node:assert/strict'

import { parseExitEntries } from '../../src/main/egress/config-file/parser.ts'

test('parses a JSON array of proxy entries', () => {
  const exits = parseExitEntries([
    { name: 'hk-1', protocol: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' },
    { host: '5.6.7.8', port: 8080 },
  ])

  assert.equal(exits.length, 2)
  assert.equal(exits[0].id, 'hk-1')
  assert.equal(exits[0].name, 'hk-1')
  assert.equal(exits[0].protocol, 'socks5')
  assert.equal(exits[0].username, 'u')
  assert.equal(exits[1].protocol, 'http')
  assert.equal(exits[1].id, '5.6.7.8:8080')
  assert.equal(exits[1].name, undefined)
})

test('accepts an object wrapper and the ip alias', () => {
  const exits = parseExitEntries({ proxies: [{ ip: '9.9.9.9', port: 3128 }] })
  assert.equal(exits.length, 1)
  assert.equal(exits[0].host, '9.9.9.9')
})

test('skips malformed entries and out-of-range ports', () => {
  const exits = parseExitEntries([
    { host: '1.1.1.1', port: 70000 },
    { host: '', port: 80 },
    { port: 80 },
    { host: '2.2.2.2', port: 443 },
    'not-an-object',
  ])
  assert.equal(exits.length, 1)
  assert.equal(exits[0].id, '2.2.2.2:443')
})

test('keeps ids unique when entries collide', () => {
  const exits = parseExitEntries([
    { host: '1.1.1.1', port: 80 },
    { host: '1.1.1.1', port: 80 },
  ])
  assert.equal(exits.length, 2)
  assert.notEqual(exits[0].id, exits[1].id)
})

test('returns an empty list for unsupported shapes', () => {
  assert.deepEqual(parseExitEntries({ foo: 'bar' }), [])
  assert.deepEqual(parseExitEntries(null), [])
})
