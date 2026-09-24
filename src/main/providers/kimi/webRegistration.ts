import { chromium, type Browser } from 'playwright-core'
import type { OAuthResult } from '../../oauth/types'
import type { WebRegistrationOptions } from '../types'
import { checkKimiToken } from './tokenCheck'
import kimiConfig from './config'

const KIMI_LOGIN_URL = 'https://www.kimi.com/login'

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Batch registration cancelled')
}

function mainlandPhone(value: string, countryCode: string): string {
  if (countryCode.trim() !== '+86') {
    throw new Error('Kimi.com only supports mainland China phone numbers (+86)')
  }
  const normalized = value.replace(/[\s-]/g, '')
  const local = normalized.startsWith('+86') ? normalized.slice(3) : normalized
  if (!/^1[3-9]\d{9}$/.test(local)) {
    throw new Error('Leased phone number must be a valid mainland China mobile number')
  }
  return local
}

export async function registerKimiOnWeb(options: WebRegistrationOptions): Promise<OAuthResult> {
  let browser: Browser | undefined
  const onAbort = () => {
    void browser?.close().catch(() => {})
  }
  options.signal.addEventListener('abort', onAbort, { once: true })

  try {
    assertNotCancelled(options.signal)
    const phone = mainlandPhone(options.phone, options.countryCode)
    browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 15000 })
    const context = await browser.newContext({ locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    await page.goto(KIMI_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    assertNotCancelled(options.signal)

    const phoneInput = page.getByTestId('login-phone-input')
    await phoneInput.waitFor({ state: 'visible' })
    await phoneInput.fill(phone)
    await page.locator('input[type="checkbox"]').check()

    const sendCode = page.getByTestId('login-send-code')
    if (!(await sendCode.isEnabled())) {
      throw new Error('Kimi.com did not accept this phone number')
    }
    await sendCode.click()
    assertNotCancelled(options.signal)

    const code = await options.resolveCode(options.signal)
    assertNotCancelled(options.signal)
    if (!code) {
      throw new Error(
        'SMS code did not arrive, or Kimi.com requires a manual verification challenge',
      )
    }
    await page.getByTestId('login-code-input').fill(code)
    const submit = page.getByTestId('login-submit')
    if (!(await submit.isEnabled())) throw new Error('Kimi.com login form is not ready')
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
    if (!credentials) throw new Error('Kimi.com did not issue access and refresh tokens')

    const now = Date.now()
    const validation = await checkKimiToken(
      { ...kimiConfig, createdAt: now, updatedAt: now },
      {
        id: 'temp',
        providerId: options.providerId,
        name: 'Kimi registration',
        credentials,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    )
    if (!validation.valid) {
      throw new Error(validation.error || 'Kimi.com issued credentials that failed validation')
    }

    return {
      success: true,
      providerId: options.providerId,
      providerType: 'kimi',
      credentials,
      accountInfo: validation.userInfo,
    }
  } catch (error) {
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'kimi',
      error: options.signal.aborted
        ? 'Batch registration cancelled'
        : error instanceof Error
          ? error.message
          : 'Kimi.com registration failed',
    }
  } finally {
    options.signal.removeEventListener('abort', onAbort)
    await browser?.close().catch(() => {})
  }
}
