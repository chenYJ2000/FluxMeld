import assert from 'node:assert/strict'
import test from 'node:test'
import axios from 'axios'
import type { Account } from '../../src/shared/types.ts'
import { storeManager } from '../../src/main/store/store.ts'
import { kimiModule } from '../../src/main/providers/kimi/index.ts'
import { KimiAdapter } from '../../src/main/providers/kimi/adapter.ts'
import { checkKimiToken } from '../../src/main/providers/kimi/tokenCheck.ts'
import { needsKimiBackgroundRefresh } from '../../src/main/providers/kimi/maintenance.ts'
import { resolveKimiAccessToken } from '../../src/main/providers/kimi/session.ts'

function jwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ app_id: 'kimi', typ: 'access', sub: 'user-1', exp }),
  ).toString('base64url')
  return `${header}.${payload}.signature`
}

function account(token: string, refresh = 'refresh-1', id = 'temp'): Account {
  return {
    id,
    providerId: 'kimi',
    name: 'Kimi user',
    credentials: { token, refresh_token: refresh },
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  }
}

test('kimi.com refresh rotates both tokens and validates using the new access token', async (t) => {
  const expired = jwt(Math.floor(Date.now() / 1000) - 60)
  const fresh = jwt(Math.floor(Date.now() / 1000) + 900)
  let saved = account(expired, 'refresh-1', 'account-1')
  const calls: string[] = []

  t.mock.method(storeManager, 'getAccountById', () => saved)
  t.mock.method(storeManager, 'updateAccount', (_id: string, patch: Partial<Account>) => {
    saved = { ...saved, ...patch, credentials: { ...patch.credentials! } }
    return saved
  })
  t.mock.method(axios, 'post', async (url: string, body: any, config: any) => {
    calls.push(url)
    if (url.startsWith('https://auth.kimi.com/')) {
      assert.equal(url, 'https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken')
      assert.deepEqual(body, { refresh_token: 'refresh-1' })
      assert.equal(config.headers.Authorization, undefined)
      return { status: 200, data: { access_token: fresh, refresh_token: 'refresh-2' } }
    }
    assert.equal(config.headers.Authorization, `Bearer ${fresh}`)
    return { status: 200, data: { subscription: { userName: 'Kimi user' } } }
  })

  const result = await checkKimiToken(kimiModule.config as any, saved)
  assert.equal(result.valid, true)
  assert.deepEqual(saved.credentials, { token: fresh, refresh_token: 'refresh-2' })
  assert.deepEqual(calls, [
    'https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken',
    'https://www.kimi.com/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription',
  ])
})

test('20 concurrent kimi.com requests share one refresh', async (t) => {
  const expired = jwt(Math.floor(Date.now() / 1000) - 60)
  const fresh = jwt(Math.floor(Date.now() / 1000) + 900)
  let saved = account(expired, 'refresh-1', 'account-2')
  let refreshCalls = 0
  let updates = 0

  t.mock.method(storeManager, 'getAccountById', () => saved)
  t.mock.method(storeManager, 'updateAccount', (_id: string, patch: Partial<Account>) => {
    saved = { ...saved, ...patch, credentials: { ...patch.credentials! } }
    updates++
    return saved
  })
  t.mock.method(axios, 'post', async () => {
    refreshCalls++
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { status: 200, data: { access_token: fresh, refresh_token: 'refresh-2' } }
  })

  const tokens = await Promise.all(Array.from({ length: 20 }, () => resolveKimiAccessToken(saved)))
  assert.deepEqual(tokens, Array(20).fill(fresh))
  assert.equal(refreshCalls, 1)
  assert.equal(updates, 1)
  assert.deepEqual(saved.credentials, { token: fresh, refresh_token: 'refresh-2' })
})

test('kimi.com retries one rejected chat after refreshing', async (t) => {
  const oldToken = jwt(Math.floor(Date.now() / 1000) + 900)
  const newToken = jwt(Math.floor(Date.now() / 1000) + 1800)
  const sent: string[] = []
  t.mock.method(axios, 'post', async (url: string, _body: unknown, config: any) => {
    if (url.startsWith('https://auth.kimi.com/')) {
      return { status: 200, data: { access_token: newToken, refresh_token: 'refresh-2' } }
    }
    sent.push(config.headers.Authorization)
    return { status: sent.length === 1 ? 401 : 200, data: {} }
  })

  const adapter = new KimiAdapter(kimiModule.config as any, account(oldToken))
  const result = await adapter.chatCompletion({
    model: 'k3',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(result.response.status, 200)
  assert.deepEqual(sent, [`Bearer ${oldToken}`, `Bearer ${newToken}`])
})

test('kimi.com refresh failure preserves saved credentials', async (t) => {
  const expired = jwt(Math.floor(Date.now() / 1000) - 60)
  const saved = account(expired, 'refresh-1', 'account-3')
  t.mock.method(storeManager, 'getAccountById', () => saved)
  const update = t.mock.method(storeManager, 'updateAccount', () => saved)
  t.mock.method(axios, 'post', async () => ({ status: 401, data: {} }))

  await assert.rejects(resolveKimiAccessToken(saved), (error: any) => error.status === 401)
  assert.equal(update.mock.callCount(), 0)
  assert.deepEqual(saved.credentials, { token: expired, refresh_token: 'refresh-1' })
})

test('validating an unsaved account does not consume its rotating refresh token', async (t) => {
  const expired = jwt(Math.floor(Date.now() / 1000) - 60)
  const refresh = t.mock.method(axios, 'post', async () => {
    throw new Error('Validation must not refresh an unsaved account')
  })

  const result = await checkKimiToken(kimiModule.config as any, account(expired))
  assert.equal(result.valid, false)
  assert.match(result.error || '', /JWT has expired/)
  assert.equal(refresh.mock.callCount(), 0)
})

test('kimi.com background refresh selects near-expiry active accounts', () => {
  const now = Math.floor(Date.now() / 1000)
  const near = account(jwt(now + 120))
  const far = account(jwt(now + 600))
  assert.equal(needsKimiBackgroundRefresh(near, now), true)
  assert.equal(needsKimiBackgroundRefresh(far, now), false)
  assert.equal(needsKimiBackgroundRefresh({ ...near, status: 'error' }, now), false)
  assert.equal(
    needsKimiBackgroundRefresh({ ...near, credentials: { token: near.credentials.token } }, now),
    false,
  )
})
