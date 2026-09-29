import assert from 'node:assert/strict'
import test from 'node:test'
import axios from 'axios'
import type { Account } from '../../src/shared/types.ts'
import { storeManager } from '../../src/main/store/store.ts'
import {
  exchangeQwenAiRefreshToken,
  getQwenAiJwtExpiry,
  mergeQwenAiCookies,
  normalizeQwenAiCredentials,
  QWEN_AI_REFRESH_URL,
  resolveQwenAiCredentials,
} from '../../src/main/providers/qwen-ai/session.ts'
import { needsQwenAiBackgroundRefresh } from '../../src/main/providers/qwen-ai/maintenance.ts'
import { QwenAiAdapter } from '../../src/main/providers/qwen-ai/adapter.ts'
import { QwenAiAdapter as OAuthAdapter } from '../../src/main/providers/qwen-ai/oauth.ts'

const now = () => Math.floor(Date.now() / 1000)
const jwt = (exp: number) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: 'user', exp })).toString('base64url')}.signature`
const account = (seconds = -60, id = 'temp'): Account => ({
  id,
  providerId: 'qwen-ai',
  name: 'Qwen',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  credentials: {
    token: jwt(now() + seconds),
    cookies: `cna=waf-cookie; refresh_token=${jwt(now() + 86400 * 30)}`,
  },
})
const success = (token: string, cookies: string[] = []) => ({
  status: 200,
  data: { success: true, data: { access_token: token } },
  headers: { 'set-cookie': cookies },
})

test('Qwen extracts refresh cookies while preserving credentials and WAF cookies', () => {
  const credentials = { token: 'access', cookie: 'cna=waf; refresh_token=a=b', unrelated: 'keep' }
  const normalized = normalizeQwenAiCredentials(credentials)
  assert.equal(normalized.refresh_token, 'a=b')
  assert.equal(normalized.cookies, credentials.cookie)
  assert.equal(normalized.unrelated, 'keep')
  assert.equal(credentials.cookie, 'cna=waf; refresh_token=a=b')
  assert.equal(getQwenAiJwtExpiry('invalid'), null)
  assert.equal(getQwenAiJwtExpiry(jwt(123)), 123)
})

test('Qwen cookie rotation and deletion keep unrelated cookies', () => {
  assert.equal(
    mergeQwenAiCookies('cna=waf; refresh_token=old; gone=old', [
      'refresh_token=new=signature; HttpOnly; Secure; Path=/',
      'gone=; Max-Age=0; Path=/',
      'x-ap=new-waf; Path=/',
    ]),
    'cna=waf; refresh_token=new=signature; x-ap=new-waf',
  )
})

test('Qwen refresh follows the official cookie protocol and persists rotated cookies in its result', async (t) => {
  const saved = account()
  const fresh = jwt(now() + 900)
  const rotated = jwt(now() + 86400 * 40)
  t.mock.method(axios, 'get', async (url: string, config: any) => {
    assert.equal(url, QWEN_AI_REFRESH_URL)
    assert.equal(config.headers.Authorization, undefined)
    assert.match(config.headers.Cookie, /cna=waf-cookie; refresh_token=/)
    assert.equal(config.headers['x-request-origin'], 'https://chat.qwen.ai')
    assert.ok(config.headers.Timezone)
    assert.ok(config.headers['X-Request-Id'])
    assert.equal(config.maxRedirects, 0)
    return success(fresh, [`refresh_token=${rotated}; HttpOnly; Secure`, 'x-ap=new-waf; Path=/'])
  })
  const result = await exchangeQwenAiRefreshToken(saved.credentials)
  assert.equal(result.token, fresh)
  assert.equal(result.refresh_token, rotated)
  assert.match(result.cookies, /cna=waf-cookie/)
  assert.match(result.cookies, /x-ap=new-waf/)
  assert.equal(saved.credentials.refresh_token, undefined)
})

test('Qwen accepts a separately entered refresh token and preserves it if the server does not rotate it', async (t) => {
  const refresh = jwt(now() + 3600)
  t.mock.method(axios, 'get', async (_url: string, config: any) => {
    assert.equal(config.headers.Cookie, `refresh_token=${refresh}`)
    return success(jwt(now() + 900))
  })
  const result = await exchangeQwenAiRefreshToken({ refresh_token: refresh })
  assert.equal(result.refresh_token, refresh)
  assert.equal(result.cookies, `refresh_token=${refresh}`)
})

test('Qwen rejects missing, expired, unauthorized and malformed refresh responses', async (t) => {
  await assert.rejects(exchangeQwenAiRefreshToken({}), /缺少 refresh token/)
  await assert.rejects(exchangeQwenAiRefreshToken({ refresh_token: jwt(1) }), /会话已过期/)
  const get = t.mock.method(axios, 'get', async () => ({
    status: 200,
    data: { success: false, data: { code: 'unauthorized' } },
    headers: {},
  }))
  await assert.rejects(exchangeQwenAiRefreshToken(account().credentials), /会话失效/)
  get.mock.mockImplementation(async () => success('not-a-jwt'))
  await assert.rejects(exchangeQwenAiRefreshToken(account().credentials), /无效 access token/)
  get.mock.mockImplementation(async () => ({
    status: 200,
    data: '<html>captcha</html>',
    headers: {},
  }))
  await assert.rejects(exchangeQwenAiRefreshToken(account().credentials), /无效响应/)
})

test('20 simultaneous Qwen requests share one refresh and one save', async (t) => {
  const original = account(-60, 'persisted')
  const originalToken = original.credentials.token
  let saved = original
  let calls = 0
  let updates = 0
  const fresh = jwt(now() + 900)
  t.mock.method(storeManager, 'getAccountById', () => saved)
  t.mock.method(storeManager, 'updateAccount', (_id: string, patch: Partial<Account>) => {
    updates++
    saved = { ...saved, ...patch }
    return saved
  })
  t.mock.method(axios, 'get', async () => {
    calls++
    await new Promise((resolve) => setTimeout(resolve, 20))
    return success(fresh)
  })
  const results = await Promise.all(
    Array.from({ length: 20 }, () => resolveQwenAiCredentials(original)),
  )
  assert.equal(calls, 1)
  assert.equal(updates, 1)
  assert.ok(results.every((credentials) => credentials.token === fresh))
  assert.equal(saved.credentials.token, fresh)
  assert.equal(original.credentials.token, originalToken)
})

test('Qwen refresh never overwrites a concurrent manual credential update', async (t) => {
  let saved = account(-60, 'changed')
  const manual = { token: jwt(now() + 7200), cookies: 'cna=manual' }
  t.mock.method(storeManager, 'getAccountById', () => saved)
  const update = t.mock.method(storeManager, 'updateAccount', () => saved)
  t.mock.method(axios, 'get', async () => {
    saved = { ...saved, credentials: manual }
    return success(jwt(now() + 900))
  })
  const result = await resolveQwenAiCredentials(saved)
  assert.deepEqual(result, manual)
  assert.equal(update.mock.calls.length, 0)
})

test('cancelling one Qwen request leaves its shared renewal running for other requests', async (t) => {
  const saved = account()
  const fresh = jwt(now() + 900)
  const controller = new AbortController()
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  t.mock.method(axios, 'get', async (_url: string, config: any) => {
    calls++
    assert.equal(config.signal, undefined)
    await pending
    return success(fresh)
  })
  const cancelled = resolveQwenAiCredentials(saved, { signal: controller.signal })
  const other = resolveQwenAiCredentials(saved)
  controller.abort(new Error('User cancelled'))
  await assert.rejects(cancelled, /User cancelled/)
  release()
  assert.equal((await other).token, fresh)
  assert.equal(calls, 1)
})

test('Qwen keeps valid access credentials on temporary refresh failure but rejects expired ones', async (t) => {
  t.mock.method(axios, 'get', async () => {
    throw new Error('temporary connection failure')
  })
  const valid = account(60)
  const result = await resolveQwenAiCredentials(valid)
  assert.equal(result.token, valid.credentials.token)
  await assert.rejects(resolveQwenAiCredentials(account()), /续期请求失败/)
})

test('a Qwen renewal wait respects the request deadline while allowing the renewal to finish', async (t) => {
  const saved = account(60)
  const fresh = jwt(now() + 900)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  t.mock.method(axios, 'get', async () => {
    calls++
    await pending
    return success(fresh)
  })
  await assert.rejects(resolveQwenAiCredentials(saved, { timeoutMs: 1 }), /等待超时/)
  const other = resolveQwenAiCredentials(saved)
  release()
  assert.equal((await other).token, fresh)
  assert.equal(calls, 1)
})

test('Qwen marks an expired revoked session as an error without clearing credentials', async (t) => {
  let saved = account(-60, 'revoked')
  const original = saved.credentials
  t.mock.method(storeManager, 'getAccountById', () => saved)
  t.mock.method(storeManager, 'updateAccount', (_id: string, patch: Partial<Account>) => {
    saved = { ...saved, ...patch }
    return saved
  })
  t.mock.method(axios, 'get', async () => ({ status: 401, data: {}, headers: {} }))
  await assert.rejects(resolveQwenAiCredentials(saved), /重新登录/)
  assert.equal(saved.status, 'error')
  assert.match(saved.errorMessage!, /重新登录/)
  assert.deepEqual(saved.credentials, original)
})

test('Qwen background maintenance selects near-expiry active sessions', () => {
  assert.equal(needsQwenAiBackgroundRefresh(account(15 * 60)), false)
  assert.equal(needsQwenAiBackgroundRefresh(account(9 * 60)), true)
  assert.equal(needsQwenAiBackgroundRefresh({ ...account(), status: 'error' }), false)
  assert.equal(needsQwenAiBackgroundRefresh({ ...account(), enabled: false }), false)
  assert.equal(
    needsQwenAiBackgroundRefresh({ ...account(), credentials: { token: jwt(1) } }),
    false,
  )
  const refreshNear = account(30 * 86400)
  assert.equal(
    needsQwenAiBackgroundRefresh({
      ...refreshNear,
      credentials: { ...refreshNear.credentials, refresh_token: jwt(now() + 3600) },
    }),
    true,
  )
})

test('Qwen retries a rejected chat once with refreshed credentials', async (t) => {
  const saved = account(3600)
  const fresh = jwt(now() + 900)
  t.mock.method(axios, 'get', async () => success(fresh))
  const adapter = new QwenAiAdapter({ id: 'qwen-ai' } as any, saved)
  const tokens: string[] = []
  ;(adapter as any).axiosInstance = {
    post: async (_url: string, _body: unknown, config: any) => {
      tokens.push(config.headers.Authorization)
      return tokens.length === 1
        ? { status: 200, data: { success: false, data: { code: 'unauthorized' } } }
        : { status: 200, data: { data: { id: 'new-chat' } } }
    },
  }
  assert.equal(await adapter.createChat('qwen3.7-max'), 'new-chat')
  assert.deepEqual(tokens, [`Bearer ${saved.credentials.token}`, `Bearer ${fresh}`])
})

test('Qwen OAuth refresh exposes the new access token, expiry and cookie credentials', async (t) => {
  const fresh = jwt(now() + 900)
  t.mock.method(axios, 'get', async () => success(fresh))
  const adapter = new OAuthAdapter({
    providerId: 'qwen-ai',
    providerType: 'qwen-ai',
    callbackPort: 0,
    authMethods: ['manual'],
  })
  const result = await adapter.refreshToken(account().credentials)
  assert.equal(result?.value, fresh)
  assert.equal(result?.expiresAt, getQwenAiJwtExpiry(fresh)! * 1000)
  assert.match(result?.extra?.cookies || '', /cna=waf-cookie/)
})
