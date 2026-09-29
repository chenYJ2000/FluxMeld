import test from 'node:test'
import assert from 'node:assert/strict'
import axios from 'axios'
import {
  checkQwenAiCredentials,
  getQwenAiCredentialError,
  parseQwenAiAuthResponse,
  QwenAiAuthenticationError,
} from '../../src/main/providers/qwen-ai/auth.ts'
import { QwenAiAdapter } from '../../src/main/providers/qwen-ai/adapter.ts'

const jwt = (payload: Record<string, unknown>) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`

test('Qwen rejects legacy encrypted and expired tokens with actionable errors', () => {
  assert.match(
    getQwenAiCredentialError(Buffer.from('v10encrypted').toString('base64'))!,
    /旧版加密/,
  )
  assert.match(getQwenAiCredentialError(jwt({ exp: 1 }))!, /expired/)
  assert.match(getQwenAiCredentialError('not-a-token')!, /Invalid/)
  assert.equal(getQwenAiCredentialError(jwt({ sub: 'user', exp: Date.now() / 1000 + 3600 })), null)
})

test('Qwen HTTP 200 error envelopes and missing identities are not healthy accounts', () => {
  for (const code of ['unauthorized', 'not found']) {
    assert.equal(
      parseQwenAiAuthResponse(200, { success: false, data: { code, details: 'Rejected' } }).valid,
      false,
    )
  }
  assert.equal(parseQwenAiAuthResponse(200, { data: {} }).valid, false)
  assert.equal(parseQwenAiAuthResponse(200, '<html>captcha</html>').valid, false)
  assert.equal(parseQwenAiAuthResponse(401, { id: 'user', email: 'user@example.com' }).valid, false)
  assert.equal(parseQwenAiAuthResponse(200, { id: 'user', email: 'user@guest.com' }).valid, false)
  assert.deepEqual(
    parseQwenAiAuthResponse(200, { id: 'user', name: 'Qwen user', email: 'user@example.com' }),
    {
      valid: true,
      userInfo: { name: 'Qwen user', email: 'user@example.com' },
    },
  )
})

test('Qwen account checks use the current session endpoint and preserve cookies', async () => {
  const originalGet = axios.get
  const token = jwt({ sub: 'user' })
  try {
    axios.get = (async (url: string, config: any) => {
      assert.equal(url, 'https://chat.qwen.ai/api/v1/auths/')
      assert.equal(config.headers.Authorization, `Bearer ${token}`)
      assert.equal(config.headers.Cookie, 'cna=test-cookie')
      return {
        status: 200,
        data: { success: false, data: { code: 'unauthorized', details: 'Session expired' } },
      }
    }) as typeof axios.get
    assert.deepEqual(await checkQwenAiCredentials({ token, cookies: 'cna=test-cookie' }), {
      valid: false,
      error: 'Session expired',
    })
  } finally {
    axios.get = originalGet
  }
})

test('Qwen chat creation classifies HTTP 200 unauthorized responses as authentication failures', async () => {
  const adapter = new QwenAiAdapter(
    { id: 'qwen-ai' } as any,
    { credentials: { token: jwt({ sub: 'user' }), cookies: 'cna=test' } } as any,
  )
  ;(adapter as any).axiosInstance = {
    post: async () => ({
      status: 200,
      data: { success: false, data: { code: 'unauthorized', details: 'Session expired' } },
    }),
  }
  await assert.rejects(adapter.createChat('qwen3.6-plus'), (error: unknown) => {
    assert.ok(error instanceof QwenAiAuthenticationError)
    assert.equal(error.status, 401)
    assert.equal(error.message, 'Session expired')
    return true
  })
})
