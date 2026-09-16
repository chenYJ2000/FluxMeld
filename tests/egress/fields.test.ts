import test from 'node:test'
import assert from 'node:assert/strict'

import { fieldDefault, resolveSourceSettings } from '../../src/main/egress/common/fields.ts'
import { CLASH_META } from '../../src/main/egress/clash/config.ts'
import { NETFOUNTAIN_META } from '../../src/main/egress/netfountain/config.ts'
import type { EgressSourceModuleMeta } from '../../src/main/egress/types.ts'

const CUSTOM_META: EgressSourceModuleMeta = {
  id: 'custom',
  labelKey: 'test.custom',
  fields: [
    { key: 'enabled', type: 'boolean', labelKey: 'test.enabled', defaultValue: true },
    {
      key: 'mode',
      type: 'select',
      labelKey: 'test.mode',
      defaultValue: 'a',
      options: [
        { value: 'a', labelKey: 'test.a' },
        { value: 'b', labelKey: 'test.b' },
      ],
    },
    { key: 'note', type: 'textarea', labelKey: 'test.note', defaultValue: 'd' },
    { key: 'secret', type: 'password', labelKey: 'test.secret' },
    { key: 'count', type: 'number', labelKey: 'test.count', defaultValue: 5, min: 1, max: 10 },
  ],
  capabilities: { rotate: true, listExits: true, expiry: false, alwaysOn: false },
}

test('fieldDefault returns declared defaults only', () => {
  assert.equal(fieldDefault(CLASH_META, 'controllerPort'), 9097)
  assert.equal(fieldDefault(CLASH_META, 'missing'), undefined)
})

test('resolveSourceSettings fills declared defaults for a missing payload', () => {
  assert.deepEqual(resolveSourceSettings(CLASH_META, undefined), {
    clashHost: '127.0.0.1',
    controllerPort: 9097,
    proxyPort: 7897,
    secret: '',
  })
})

test('resolveSourceSettings coerces provided values and drops unknown keys', () => {
  const resolved = resolveSourceSettings(CLASH_META, {
    clashHost: '10.0.0.1',
    controllerPort: '1234',
    secret: 's3cret',
    unknown: 'drop-me',
  })
  assert.equal(resolved.clashHost, '10.0.0.1')
  assert.equal(resolved.controllerPort, 1234)
  assert.equal(resolved.secret, 's3cret')
  assert.equal('unknown' in resolved, false)
})

test('resolveSourceSettings falls back on blank text and invalid numbers', () => {
  const resolved = resolveSourceSettings(CLASH_META, { clashHost: '   ', controllerPort: 'abc' })
  assert.equal(resolved.clashHost, '127.0.0.1')
  assert.equal(resolved.controllerPort, 9097)
})

test('resolveSourceSettings clamps numbers to the declared bounds', () => {
  assert.equal(resolveSourceSettings(CUSTOM_META, { count: 999 }).count, 10)
  assert.equal(resolveSourceSettings(CUSTOM_META, { count: -3 }).count, 1)
  assert.equal(
    resolveSourceSettings(NETFOUNTAIN_META, { minRemainingSeconds: -5 }).minRemainingSeconds,
    0,
  )
})

test('resolveSourceSettings normalizes boolean and select fields', () => {
  assert.equal(resolveSourceSettings(CUSTOM_META, { enabled: 'yes' }).enabled, true)
  assert.equal(resolveSourceSettings(CUSTOM_META, { enabled: false }).enabled, false)
  assert.equal(resolveSourceSettings(CUSTOM_META, { mode: 'nope' }).mode, 'a')
  assert.equal(resolveSourceSettings(CUSTOM_META, { mode: 'b' }).mode, 'b')
})

test('resolveSourceSettings keeps password values as-is and defaults textarea', () => {
  assert.equal(resolveSourceSettings(CUSTOM_META, { secret: '' }).secret, '')
  assert.equal(resolveSourceSettings(CUSTOM_META, {}).note, 'd')
  assert.equal(resolveSourceSettings(CUSTOM_META, { note: '  ' }).note, 'd')
})

test('resolveSourceSettings applies NetFountain defaults', () => {
  const resolved = resolveSourceSettings(NETFOUNTAIN_META, {})
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:9000/api/v1')
  assert.equal(resolved.site, 'glm')
  assert.equal(resolved.minRemainingSeconds, 120)
  assert.equal(resolved.emptyPoolWaitMs, 20000)
})
