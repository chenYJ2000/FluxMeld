import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCOUNT_EXPORT_TYPE,
  ACCOUNT_EXPORT_VERSION,
  buildAccountExport,
  findDuplicateAccount,
  parseAccountExport,
  serializeAccountExport,
  toExportedAccount,
} from '../../src/shared/accountTransfer.ts'

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acc-1',
    providerId: 'deepseek',
    name: 'Team Alpha',
    email: 'alpha@example.com',
    credentials: { token: 'secret' },
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    requestCount: 10,
    todayUsed: 3,
    dailyLimit: 100,
    ...overrides,
  } as any
}

test('toExportedAccount keeps only portable fields', () => {
  const exported = toExportedAccount(makeAccount())

  assert.deepEqual(exported, {
    providerId: 'deepseek',
    name: 'Team Alpha',
    email: 'alpha@example.com',
    credentials: { token: 'secret' },
    dailyLimit: 100,
  })
  assert.equal('id' in exported, false)
  assert.equal('status' in exported, false)
  assert.equal('requestCount' in exported, false)
})

test('build/serialize/parse round-trips an export file', () => {
  const file = buildAccountExport([makeAccount()], 'deepseek', new Date('2026-09-16T00:00:00.000Z'))
  const parsed = parseAccountExport(serializeAccountExport(file))

  assert.equal(parsed.type, ACCOUNT_EXPORT_TYPE)
  assert.equal(parsed.version, ACCOUNT_EXPORT_VERSION)
  assert.equal(parsed.providerId, 'deepseek')
  assert.equal(parsed.exportedAt, '2026-09-16T00:00:00.000Z')
  assert.equal(parsed.accounts.length, 1)
  assert.deepEqual(parsed.accounts[0].credentials, { token: 'secret' })
})

test('parseAccountExport omits providerId when exporting all providers', () => {
  const file = buildAccountExport([makeAccount()])
  const parsed = parseAccountExport(serializeAccountExport(file))
  assert.equal(parsed.providerId, undefined)
})

test('parseAccountExport rejects malformed input', () => {
  assert.throws(() => parseAccountExport('not json'), /Invalid JSON format/)
  assert.throws(() => parseAccountExport('[]'), /Invalid account export file/)
  assert.throws(() => parseAccountExport('{"type":"other","version":1,"accounts":[]}'), /type/)
  assert.throws(
    () => parseAccountExport('{"type":"fluxmeld-accounts","version":99,"accounts":[]}'),
    /Unsupported account export version/,
  )
  assert.throws(
    () => parseAccountExport('{"type":"fluxmeld-accounts","version":1}'),
    /accounts array/,
  )
  assert.throws(
    () =>
      parseAccountExport(
        '{"type":"fluxmeld-accounts","version":1,"accounts":[{"providerId":"p","name":"n","credentials":{}}]}',
      ),
    /credentials/,
  )
  assert.throws(
    () =>
      parseAccountExport(
        '{"type":"fluxmeld-accounts","version":1,"accounts":[{"name":"n","credentials":{"t":"x"}}]}',
      ),
    /providerId/,
  )
})

test('findDuplicateAccount matches provider and identical credentials', () => {
  const existing = [
    makeAccount({ id: 'a', providerId: 'deepseek', credentials: { token: 'same' } }),
    makeAccount({ id: 'b', providerId: 'glm', credentials: { token: 'same' } }),
  ]

  assert.equal(
    findDuplicateAccount(existing, {
      providerId: 'deepseek',
      name: 'x',
      credentials: { token: 'same' },
    })?.id,
    'a',
  )
  assert.equal(
    findDuplicateAccount(existing, {
      providerId: 'deepseek',
      name: 'x',
      credentials: { token: 'other' },
    }),
    undefined,
  )
  assert.equal(
    findDuplicateAccount(existing, {
      providerId: 'kimi',
      name: 'x',
      credentials: { token: 'same' },
    }),
    undefined,
  )
})
