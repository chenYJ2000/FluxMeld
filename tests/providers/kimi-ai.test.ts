import assert from 'node:assert/strict'
import test from 'node:test'
import axios from 'axios'
import { kimiAiModule } from '../../src/main/providers/kimi-ai/index.ts'
import { KimiAdapter } from '../../src/main/providers/kimi/adapter.ts'
import { checkKimiAiToken } from '../../src/main/providers/kimi-ai/tokenCheck.ts'
import { needsKimiAiBackgroundRefresh } from '../../src/main/providers/kimi-ai/maintenance.ts'
import { resolveKimiAiAccessToken } from '../../src/main/providers/kimi-ai/session.ts'
import { storeManager } from '../../src/main/store/store.ts'
import { normalizeOAuthResult } from '../../src/main/providers/oauthCredentials.ts'
import type { Account } from '../../src/shared/types.ts'

function jwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ app_id: 'kimi', typ: 'access', sub: 'user-1', exp }),
  ).toString('base64url')
  return `${header}.${payload}.signature`
}

function account(token: string, refreshToken = 'refresh-1', id = 'temp'): Account {
  return {
    id,
    providerId: 'kimi-ai',
    name: 'International Kimi',
    credentials: { token, refresh_token: refreshToken },
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  }
}

test('kimi.ai and kimi.com are distinct providers with distinct credential sources and models', () => {
  assert.equal(kimiAiModule.id, 'kimi-ai')
  assert.equal(kimiAiModule.config.apiEndpoint, 'https://www.kimi.ai')
  assert.deepEqual(kimiAiModule.config.supportedModels, ['Kimi-AI-K3', 'Kimi-AI-K2.6'])
  assert.deepEqual(kimiAiModule.tokenExtraction?.requiredKeys, ['access_token', 'refresh_token'])
  assert.deepEqual(kimiAiModule.tokenExtraction?.tokenSources, [
    { type: 'localStorage', key: 'access_token' },
    { type: 'localStorage', key: 'refresh_token' },
  ])

  const normalized = normalizeOAuthResult('kimi-ai', {
    success: true,
    providerId: 'kimi-ai',
    providerType: 'kimi-ai',
    credentials: { access_token: 'access', refresh_token: 'refresh', unrelated: 'secret' },
  })
  assert.deepEqual(normalized.credentials, { token: 'access', refresh_token: 'refresh' })
})

test('kimi.ai validation and chat use only the international domain and Bearer auth', async (t) => {
  const token = jwt(Math.floor(Date.now() / 1000) + 3600)
  const calls: Array<{ url: string; authorization?: string; cookie?: string }> = []
  t.mock.method(axios, 'get', async (url: string, config: any) => {
    calls.push({ url, authorization: config.headers.Authorization, cookie: config.headers.Cookie })
    return { status: 200, data: { id: 'user-1', name: 'Kimi user' } }
  })
  t.mock.method(axios, 'post', async (url: string, _body: unknown, config: any) => {
    calls.push({ url, authorization: config.headers.Authorization, cookie: config.headers.Cookie })
    return { status: 200, data: {} }
  })

  const validation = await checkKimiAiToken(kimiAiModule.config, account(token))
  assert.equal(validation.valid, true)
  const adapter = new KimiAdapter(kimiAiModule.config as any, account(token))
  const result = await adapter.chatCompletion({
    model: 'k3',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(result.response.status, 200)
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://www.kimi.ai/api/user',
      'https://www.kimi.ai/apiv2/kimi.gateway.chat.v1.ChatService/Chat',
    ],
  )
  for (const call of calls) {
    assert.equal(call.authorization, `Bearer ${token}`)
    assert.equal(call.cookie, undefined)
  }
})

test('expired kimi.ai access token refreshes, rotates credentials, and validates on kimi.ai', async (t) => {
  const expired = jwt(Math.floor(Date.now() / 1000) - 60)
  const fresh = jwt(Math.floor(Date.now() / 1000) + 3600)
  let saved = account(expired, 'refresh-1', 'account-1')
  let updates = 0
  const calls: string[] = []
  t.mock.method(storeManager, 'getAccountById', () => saved)
  t.mock.method(storeManager, 'updateAccount', (_id: string, patch: Partial<Account>) => {
    saved = { ...saved, ...patch, credentials: { ...patch.credentials! } }
    updates++
    return saved
  })
  t.mock.method(axios, 'get', async (url: string, config: any) => {
    calls.push(url)
    if (url.endsWith('/api/auth/token/refresh')) {
      assert.equal(config.headers.Authorization, 'Bearer refresh-1')
      return { status: 200, data: { access_token: fresh, refresh_token: 'refresh-2' } }
    }
    assert.equal(config.headers.Authorization, `Bearer ${fresh}`)
    return { status: 200, data: { id: 'user-1', name: 'Kimi user' } }
  })

  const result = await checkKimiAiToken(kimiAiModule.config, saved)
  assert.equal(result.valid, true)
  assert.deepEqual(saved.credentials, { token: fresh, refresh_token: 'refresh-2' })
  assert.equal(updates, 1)
  assert.deepEqual(calls, [
    'https://www.kimi.ai/api/auth/token/refresh',
    'https://www.kimi.ai/api/user',
  ])
})

test('kimi.ai retries one rejected chat after renewing its access token', async (t) => {
  const oldToken = jwt(Math.floor(Date.now() / 1000) + 3600)
  const newToken = jwt(Math.floor(Date.now() / 1000) + 7200)
  const chatTokens: string[] = []
  t.mock.method(axios, 'get', async (url: string, config: any) => {
    assert.equal(url, 'https://www.kimi.ai/api/auth/token/refresh')
    assert.equal(config.headers.Authorization, 'Bearer refresh-1')
    return { status: 200, data: { access_token: newToken } }
  })
  t.mock.method(axios, 'post', async (url: string, _body: unknown, config: any) => {
    assert.equal(url, 'https://www.kimi.ai/apiv2/kimi.gateway.chat.v1.ChatService/Chat')
    chatTokens.push(config.headers.Authorization)
    return { status: chatTokens.length === 1 ? 401 : 200, data: {} }
  })

  const adapter = new KimiAdapter(kimiAiModule.config as any, account(oldToken))
  const result = await adapter.chatCompletion({
    model: 'k3',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(result.response.status, 200)
  assert.deepEqual(chatTokens, [`Bearer ${oldToken}`, `Bearer ${newToken}`])
})

test('failed kimi.ai renewal leaves stored credentials intact', async (t) => {
  const expired = jwt(Math.floor(Date.now() / 1000) - 60)
  const saved = account(expired, 'refresh-1', 'account-1')
  t.mock.method(storeManager, 'getAccountById', () => saved)
  const update = t.mock.method(storeManager, 'updateAccount', () => saved)
  t.mock.method(axios, 'get', async () => ({ status: 401, data: {} }))

  const result = await checkKimiAiToken(kimiAiModule.config, saved)
  assert.equal(result.valid, false)
  assert.equal(update.mock.calls.length, 0)
  assert.deepEqual(saved.credentials, { token: expired, refresh_token: 'refresh-1' })
})

test('20 simultaneous kimi.ai requests share one refresh and use the saved token', async (t) => {
  const expired = jwt(Math.floor(Date.now() / 1000) - 60)
  const fresh = jwt(Math.floor(Date.now() / 1000) + 3600)
  let saved = account(expired, 'refresh-1', 'account-1')
  let refreshCalls = 0
  let updates = 0

  t.mock.method(storeManager, 'getAccountById', () => saved)
  t.mock.method(storeManager, 'updateAccount', (_id: string, patch: Partial<Account>) => {
    saved = { ...saved, ...patch, credentials: { ...patch.credentials! } }
    updates++
    return saved
  })
  t.mock.method(axios, 'get', async () => {
    refreshCalls++
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { status: 200, data: { access_token: fresh, refresh_token: 'refresh-2' } }
  })

  const tokens = await Promise.all(
    Array.from({ length: 20 }, () => resolveKimiAiAccessToken(saved)),
  )
  assert.deepEqual(tokens, Array(20).fill(fresh))
  assert.equal(refreshCalls, 1)
  assert.equal(updates, 1)
  assert.deepEqual(saved.credentials, { token: fresh, refresh_token: 'refresh-2' })
})

test('kimi.ai background refresh targets near expiry and ignores inactive accounts', () => {
  const now = Math.floor(Date.now() / 1000)
  const far = account(jwt(now + 30 * 86400), jwt(now + 90 * 86400))
  const accessNear = account(jwt(now + 20 * 3600), jwt(now + 90 * 86400))
  const refreshNear = account(jwt(now + 30 * 86400), jwt(now + 6 * 86400))

  assert.equal(needsKimiAiBackgroundRefresh(far, now), false)
  assert.equal(needsKimiAiBackgroundRefresh(accessNear, now), true)
  assert.equal(needsKimiAiBackgroundRefresh(refreshNear, now), true)
  assert.equal(needsKimiAiBackgroundRefresh({ ...accessNear, status: 'error' }, now), false)
  assert.equal(needsKimiAiBackgroundRefresh({ ...accessNear, enabled: false }, now), false)
})
