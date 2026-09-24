import { chromium, type Browser } from 'playwright-core'
import type { OAuthResult } from '../../oauth/types'
import type { WebRegistrationOptions } from '../types'
import { checkKimiAiToken } from './tokenCheck'
import kimiAiConfig from './config'

const KIMI_AI_URL = 'https://www.kimi.ai/'

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Batch registration cancelled')
}

function cleanCountryCode(value: string): string {
  const code = value.trim()
  if (!/^\+[1-9]\d{0,3}$/.test(code)) {
    throw new Error('Select a valid international calling code, such as +1 or +852')
  }
  return code
}

function localPhone(phone: string, countryCode: string): string {
  const normalized = phone.replace(/[\s-]/g, '')
  if (normalized.startsWith('+')) {
    if (!normalized.startsWith(countryCode)) {
      throw new Error('Leased phone number does not match the selected country code')
    }
    return normalized.slice(countryCode.length)
  }
  return normalized
}

export async function registerKimiAiOnWeb(options: WebRegistrationOptions): Promise<OAuthResult> {
  let browser: Browser | undefined
  const onAbort = () => {
    void browser?.close().catch(() => {})
  }
  options.signal.addEventListener('abort', onAbort, { once: true })

  try {
    assertNotCancelled(options.signal)
    const countryCode = cleanCountryCode(options.countryCode)
    const phone = localPhone(options.phone, countryCode)
    if (!/^\d{6,15}$/.test(phone)) throw new Error('Leased phone number is invalid')

    browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 15000 })
    const context = await browser.newContext({ locale: 'en-US' })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    await page.goto(KIMI_AI_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    assertNotCancelled(options.signal)

    await page.locator('button.login-button').click()
    const phoneInput = page.getByTestId('login-phone-input')
    await phoneInput.waitFor({ state: 'visible' })

    const regionInput = page.locator('.region-code-select__input')
    await regionInput.click()
    await regionInput.fill(countryCode)
    const region = page
      .locator('.region-code-select__item')
      .filter({ hasText: new RegExp(`\\${countryCode}$`) })
      .first()
    if ((await region.count()) === 0) {
      throw new Error(`Kimi AI does not offer calling code ${countryCode}`)
    }
    await region.click()

    await phoneInput.fill(phone)
    await page.locator('input[type="checkbox"]').check()
    const sendCode = page.getByTestId('login-send-code')
    if (!(await sendCode.isEnabled())) {
      throw new Error('Kimi AI did not accept this phone number or calling code')
    }
    await sendCode.click()
    assertNotCancelled(options.signal)

    const code = await options.resolveCode(options.signal)
    assertNotCancelled(options.signal)
    if (!code) {
      throw new Error(
        'SMS code did not arrive, or Kimi AI requires a manual verification challenge',
      )
    }
    await page.getByTestId('login-code-input').fill(code)
    const submit = page.getByTestId('login-submit')
    if (!(await submit.isEnabled())) throw new Error('Kimi AI login form is not ready')
    await submit.click()

    const deadline = Date.now() + Math.min(options.timeout ?? 300000, 300000)
    let credentials: Record<string, string> | null = null
    while (Date.now() < deadline) {
      assertNotCancelled(options.signal)
      try {
        credentials = await page.evaluate(() => {
          const token = localStorage.getItem('access_token')
          const refresh_token = localStorage.getItem('refresh_token')
          return token && refresh_token ? { token, refresh_token } : null
        })
      } catch (error) {
        if (page.isClosed()) throw error
        // Login can replace the document while credentials are being issued.
      }
      if (credentials) break
      await page.waitForTimeout(1000)
    }
    if (!credentials) throw new Error('Kimi AI did not issue access and refresh tokens')

    const validation = await checkKimiAiToken(
      {
        ...kimiAiConfig,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'temp',
        providerId: options.providerId,
        name: 'Kimi AI registration',
        credentials,
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    )
    if (!validation.valid) {
      throw new Error(validation.error || 'Kimi AI issued credentials that failed validation')
    }

    return {
      success: true,
      providerId: options.providerId,
      providerType: 'kimi-ai',
      credentials,
      accountInfo: validation.userInfo,
    }
  } catch (error) {
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'kimi-ai',
      error: options.signal.aborted
        ? 'Batch registration cancelled'
        : error instanceof Error
          ? error.message
          : 'Kimi AI registration failed',
    }
  } finally {
    options.signal.removeEventListener('abort', onAbort)
    await browser?.close().catch(() => {})
  }
}
