import assert from 'node:assert/strict'
import test from 'node:test'
import axios from 'axios'
import { chromium } from 'playwright-core'
import { kimiAiModule } from '../../src/main/providers/kimi-ai/index.ts'
import { registerKimiAiOnWeb } from '../../src/main/providers/kimi-ai/webRegistration.ts'

function fakeBrowser(tokens: Record<string, string> | null) {
  const actions: string[] = []
  const locator = {
    click: async () => {
      actions.push('click')
    },
    fill: async (value: string) => {
      actions.push(`fill:${value}`)
    },
    check: async () => {
      actions.push('terms')
    },
    waitFor: async () => {},
    isEnabled: async () => true,
    count: async () => 1,
    filter: () => locator,
    first: () => locator,
  }
  const page = {
    setDefaultTimeout: () => {},
    goto: async (url: string) => {
      actions.push(`goto:${url}`)
    },
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

test('kimi.ai exposes registration for web and uses phone plus SMS without a password', () => {
  assert.equal(kimiAiModule.config.capabilities?.webBatchRegister, true)
  assert.equal(kimiAiModule.registration?.registrationUrl, 'https://www.kimi.ai/')
  assert.deepEqual(kimiAiModule.registration?.fields, [{ value: 'phone' }, { value: 'code' }])
  assert.equal(kimiAiModule.registration?.requiresTermsConsent, true)
  assert.equal(typeof kimiAiModule.webRegistration, 'function')
})

test('web registration saves only validated Kimi AI tokens and closes the browser', async (t) => {
  const { browser, actions } = fakeBrowser({ token: 'access-1', refresh_token: 'refresh-1' })
  t.mock.method(chromium, 'launch', async () => browser as any)
  t.mock.method(axios, 'get', async (url: string, config: any) => {
    assert.equal(url, 'https://www.kimi.ai/api/user')
    assert.equal(config.headers.Authorization, 'Bearer access-1')
    return { status: 200, data: { id: 'user-1', name: 'Kimi user' } }
  })

  const result = await registerKimiAiOnWeb({
    providerId: 'kimi-ai',
    phone: '+18551234567',
    countryCode: '+1',
    resolveCode: async () => '123456',
    signal: new AbortController().signal,
  })
  assert.equal(result.success, true)
  assert.deepEqual(result.credentials, { token: 'access-1', refresh_token: 'refresh-1' })
  assert.ok(actions.includes('fill:8551234567'))
  assert.ok(actions.includes('fill:123456'))
  assert.ok(actions.includes('terms'))
  assert.equal(actions.at(-1), 'close')
})

test('web registration does not return credentials when SMS verification fails', async (t) => {
  const { browser, actions } = fakeBrowser(null)
  t.mock.method(chromium, 'launch', async () => browser as any)
  const result = await registerKimiAiOnWeb({
    providerId: 'kimi-ai',
    phone: '+18551234567',
    countryCode: '+1',
    resolveCode: async () => null,
    signal: new AbortController().signal,
  })
  assert.equal(result.success, false)
  assert.equal(result.credentials, undefined)
  assert.match(result.error || '', /SMS code did not arrive/)
  assert.equal(actions.at(-1), 'close')
})

test('web registration rejects a phone from a different region before opening Chrome', async (t) => {
  const launch = t.mock.method(chromium, 'launch', async () => {
    throw new Error('Browser should not start')
  })
  const result = await registerKimiAiOnWeb({
    providerId: 'kimi-ai',
    phone: '+85261234567',
    countryCode: '+1',
    resolveCode: async () => '123456',
    signal: new AbortController().signal,
  })
  assert.equal(result.success, false)
  assert.match(result.error || '', /does not match/)
  assert.equal(launch.mock.calls.length, 0)
})
