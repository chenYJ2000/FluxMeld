import assert from 'node:assert/strict'
import test from 'node:test'
import axios from 'axios'
import { kimiModule } from '../../src/main/providers/kimi/index.ts'
import { KimiAdapter as KimiOAuthAdapter } from '../../src/main/providers/kimi/oauth.ts'
import { KimiAdapter } from '../../src/main/providers/kimi/adapter.ts'
import { checkKimiToken } from '../../src/main/providers/kimi/tokenCheck.ts'
import { normalizeOAuthResult } from '../../src/main/providers/oauthCredentials.ts'

const COOKIE = 'djEwXW3UpK' + 'A'.repeat(60)
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJhcHBfaWQiOiJraW1pIiwidHlwIjoiYWNjZXNzIiwic3ViIjoidXNlci0xIn0.sig'

test('Kimi in-app login accepts the session cookie as a legacy credential', () => {
  assert.equal(kimiModule.config.authType, 'cookie')
  assert.deepEqual(kimiModule.tokenExtraction?.tokenSources, [
    { type: 'localStorage', key: 'access_token' },
    { type: 'localStorage', key: 'refresh_token' },
    { type: 'cookie', key: 'kimi-auth' },
  ])
  assert.deepEqual(kimiModule.tokenExtraction?.loginAlternativeKeys, [['kimi-auth']])

  const normalized = normalizeOAuthResult('kimi', {
    success: true,
    providerId: 'kimi',
    providerType: 'kimi',
    credentials: {
      'kimi-auth': COOKIE,
      cookies: { 'kimi-auth': COOKIE, unrelated: 'secret' } as unknown as string,
    },
  })
  assert.deepEqual(normalized.credentials, { token: COOKIE })
})

test('Kimi manual login returns the canonical token field', async (t) => {
  let authHeaders: Array<Record<string, string>> = []
  t.mock.method(axios, 'post', async (_url: unknown, _body: unknown, config: any) => {
    authHeaders = [...authHeaders, config.headers]
    return {
      status: 200,
      data: { subscription: { userId: 'user-1', userName: 'Kimi user' } },
    }
  })
  const adapter = new KimiOAuthAdapter({
    providerId: 'kimi',
    providerType: 'kimi',
    authMethods: ['manual'],
  })

  const result = await adapter.loginWithToken('kimi', COOKIE)
  assert.equal(result.success, true)
  assert.deepEqual(result.credentials, { token: COOKIE })
  assert.equal(adapter.detectTokenType(JWT), 'jwt')
  assert.equal(adapter.detectTokenType(COOKIE), 'cookie')

  const cookieValidation = await adapter.validateToken({ 'kimi-auth': COOKIE })
  assert.equal(cookieValidation.valid, true)
  assert.equal(cookieValidation.tokenType, 'cookie')
  assert.equal(authHeaders[0].Cookie, `kimi-auth=${COOKIE}`)
  assert.equal(authHeaders[1].Cookie, `kimi-auth=${COOKIE}`)
  assert.equal(authHeaders[1].Authorization, undefined)
})

test('Kimi account validation accepts legacy accessToken credentials', async (t) => {
  let authHeader: string | undefined
  t.mock.method(axios, 'post', async (_url: unknown, _body: unknown, config: any) => {
    authHeader = config.headers.Authorization
    return { status: 200, data: { subscription: { userName: 'Kimi user' } } }
  })

  const result = await checkKimiToken(
    kimiModule.config as any,
    { credentials: { accessToken: JWT } } as any,
  )
  assert.equal(result.valid, true)
  assert.equal(authHeader, `Bearer ${JWT}`)
})

test('Kimi validation identifies an expired JWT before contacting the upstream API', async (t) => {
  const expiredJwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(
    JSON.stringify({ app_id: 'kimi', typ: 'access', exp: 1 }),
  ).toString('base64url')}.signature`
  const request = t.mock.method(axios, 'post', async () => {
    throw new Error('An expired token must not be sent')
  })

  const result = await checkKimiToken(
    kimiModule.config as any,
    { credentials: { token: expiredJwt } } as any,
  )

  assert.equal(result.valid, false)
  assert.match(result.error || '', /JWT has expired/)
  assert.equal(request.mock.callCount(), 0)
})

test('Kimi chat preserves 401 and 403 authentication statuses for account handling', async (t) => {
  let upstreamStatus = 401
  let authHeader: string | undefined
  t.mock.method(axios, 'post', async (_url: unknown, _body: unknown, config: any) => {
    authHeader = config.headers.Authorization
    return { status: upstreamStatus, data: null }
  })

  for (const status of [401, 403]) {
    upstreamStatus = status
    const adapter = new KimiAdapter(
      kimiModule.config as any,
      { credentials: { accessToken: JWT } } as any,
    )
    await assert.rejects(
      adapter.chatCompletion({ model: 'k3', messages: [{ role: 'user', content: 'hi' }] }),
      (error: any) => {
        assert.equal(error.status, status)
        assert.equal(error.message.includes(JWT), false)
        return true
      },
    )
    assert.equal(authHeader, `Bearer ${JWT}`)
  }
})

test('Kimi chat sends the saved session credential as a cookie', async (t) => {
  let headers: Record<string, string> = {}
  t.mock.method(axios, 'post', async (_url: unknown, _body: unknown, config: any) => {
    headers = config.headers
    return { status: 401, data: null }
  })

  const adapter = new KimiAdapter(
    kimiModule.config as any,
    {
      credentials: { token: COOKIE },
    } as any,
  )
  await assert.rejects(
    adapter.chatCompletion({ model: 'k3', messages: [{ role: 'user', content: 'hi' }] }),
    (error: any) => error.status === 401,
  )
  assert.equal(headers.Cookie, `kimi-auth=${COOKIE}`)
  assert.equal(headers.Authorization, undefined)
})
