import assert from 'node:assert/strict'
import test from 'node:test'
import axios from 'axios'
import { chromium } from 'playwright-core'
import { kimiModule } from '../../src/main/providers/kimi/index.ts'
import { registerKimiOnWeb } from '../../src/main/providers/kimi/webRegistration.ts'

function fakeBrowser(tokens: Record<string, string> | null) {
  const actions: string[] = []
  const locator = {
    click: async () => actions.push('click'),
    fill: async (value: string) => actions.push(`fill:${value}`),
    check: async () => actions.push('terms'),
    waitFor: async () => {},
    isEnabled: async () => true,
  }
  const page = {
    setDefaultTimeout: () => {},
    goto: async (url: string) => actions.push(`goto:${url}`),
    locator: () => locator,
    getByTestId: () => locator,
    evaluate: async () => tokens,
    waitForTimeout: async () => {},
    isClosed: () => false,
  }
  const browser = {
    newContext: async () => ({ newPage: async () => page }),
    close: async () => {
      actions.push('close')
    },
  }
  return { browser, actions }
}

test('kimi.com registration uses SMS and requires renewable credentials', () => {
  assert.equal(kimiModule.config.capabilities?.batchRegister, true)
  assert.equal(kimiModule.config.capabilities?.webBatchRegister, true)
  assert.equal(kimiModule.registration?.registrationUrl, 'https://www.kimi.com/login')
  assert.deepEqual(
    kimiModule.registration?.fields?.map((field) => field.value),
    ['phone', 'code'],
  )
  assert.equal(kimiModule.registration?.requiresTermsConsent, true)
  assert.deepEqual(kimiModule.tokenExtraction?.requiredKeys, ['access_token', 'refresh_token'])
})

test('web registration validates and saves access and refresh tokens', async (t) => {
  const { browser, actions } = fakeBrowser({ token: 'access-1', refresh_token: 'refresh-1' })
  t.mock.method(chromium, 'launch', async () => browser as any)
  t.mock.method(axios, 'post', async (url: string, _body: unknown, config: any) => {
    assert.equal(
      url,
      'https://www.kimi.com/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription',
    )
    assert.equal(config.headers.Authorization, 'Bearer access-1')
    return { status: 200, data: { subscription: { userName: 'Kimi user' } } }
  })

  const result = await registerKimiOnWeb({
    providerId: 'kimi',
    phone: '+8613812345678',
    countryCode: '+86',
    resolveCode: async () => '123456',
    signal: new AbortController().signal,
  })
  assert.equal(result.success, true)
  assert.deepEqual(result.credentials, { token: 'access-1', refresh_token: 'refresh-1' })
  assert.ok(actions.includes('fill:13812345678'))
  assert.ok(actions.includes('goto:https://www.kimi.com/login'))
  assert.ok(actions.includes('fill:123456'))
  assert.ok(actions.includes('terms'))
  assert.equal(actions.at(-1), 'close')
})

test('web registration fails cleanly when SMS verification is unavailable', async (t) => {
  const { browser, actions } = fakeBrowser(null)
  t.mock.method(chromium, 'launch', async () => browser as any)
  const result = await registerKimiOnWeb({
    providerId: 'kimi',
    phone: '13812345678',
    countryCode: '+86',
    resolveCode: async () => null,
    signal: new AbortController().signal,
  })
  assert.equal(result.success, false)
  assert.equal(result.credentials, undefined)
  assert.match(result.error || '', /SMS code did not arrive/)
  assert.equal(actions.at(-1), 'close')
})

test('web registration never saves credentials rejected by Kimi.com', async (t) => {
  const { browser, actions } = fakeBrowser({ token: 'invalid-access', refresh_token: 'refresh-1' })
  t.mock.method(chromium, 'launch', async () => browser as any)
  t.mock.method(axios, 'post', async () => ({ status: 401, data: null }))
  const result = await registerKimiOnWeb({
    providerId: 'kimi',
    phone: '13812345678',
    countryCode: '+86',
    resolveCode: async () => '123456',
    signal: new AbortController().signal,
  })
  assert.equal(result.success, false)
  assert.equal(result.credentials, undefined)
  assert.match(result.error || '', /Token expired or invalid/)
  assert.equal(actions.at(-1), 'close')
})

test('web registration rejects unsupported regions before launching Chrome', async (t) => {
  const launch = t.mock.method(chromium, 'launch', async () => {
    throw new Error('Browser should not start')
  })
  const result = await registerKimiOnWeb({
    providerId: 'kimi',
    phone: '+18551234567',
    countryCode: '+1',
    resolveCode: async () => '123456',
    signal: new AbortController().signal,
  })
  assert.equal(result.success, false)
  assert.match(result.error || '', /only supports mainland China/)
  assert.equal(launch.mock.calls.length, 0)
})
