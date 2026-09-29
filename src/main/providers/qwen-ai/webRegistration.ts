import { chromium, type Browser, type Page, type Response } from 'playwright-core'
import type { OAuthResult } from '../../oauth/types'
import type { WebRegistrationOptions } from '../types'
import { getQwenAiCredentialError, parseQwenAiAuthResponse } from './auth'

const SIGNUP_URL = 'https://chat.qwen.ai/auth?action=signup'
const CODE_SELECTOR = '.qwenchat-verification-code-input-cell, input[autocomplete="one-time-code"]'

/** A fresh browser context keeps each inbox and its HttpOnly refresh cookie isolated. */
export async function registerQwenAiOnWeb(options: WebRegistrationOptions): Promise<OAuthResult> {
  let browser: Browser | undefined
  const timeoutController = new AbortController()
  const signal = AbortSignal.any([options.signal, timeoutController.signal])
  const timeout = Math.min(options.timeout ?? 300000, 300000)
  const timer = setTimeout(() => timeoutController.abort(), Math.max(1, timeout))
  const assertActive = () => {
    if (signal.aborted) {
      throw new Error(
        options.signal.aborted ? 'Batch registration cancelled' : 'Qwen registration timed out',
      )
    }
  }
  let rejectAbort: (reason: Error) => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => {
    rejectAbort(
      new Error(
        options.signal.aborted ? 'Batch registration cancelled' : 'Qwen registration timed out',
      ),
    )
    void browser
      ?.close()
      .catch((error) => console.warn('Qwen registration browser cleanup failed', error.name))
  }
  signal.addEventListener('abort', onAbort, { once: true })

  const run = async (): Promise<OAuthResult> => {
    assertActive()
    const email = options.email?.trim() || ''
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Qwen registration requires a valid email address')
    }
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      timeout: 15000,
      args: ['--no-proxy-server'],
    })
    // Cancellation may arrive before launch resolves; close the newly created browser too.
    if (signal.aborted) {
      await browser.close()
      assertActive()
    }
    const context = await browser.newContext({ locale: 'en-US' })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    let requestFailure: string | null = null
    let usesEmailOtp = false
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (
        url.hostname === 'auth.qwen.ai' &&
        url.pathname.endsWith('/auths/otp/email/request') &&
        request.method() === 'POST'
      ) {
        usesEmailOtp = true
      }
    })
    const pendingResponses = new Set<Promise<void>>()
    page.on('response', (response) => {
      if (response.request().method() === 'OPTIONS') return
      const url = new URL(response.url())
      if (url.hostname !== 'auth.qwen.ai' && url.hostname !== 'chat.qwen.ai') return
      if (!/\/auths\/(?:otp\/email\/(?:request|verify)|signup)\/?$/.test(url.pathname)) return
      const pending = checkQwenAiRegistrationResponse(response).then((error) => {
        if (error) requestFailure = error
      })
      pendingResponses.add(pending)
      void pending.finally(() => pendingResponses.delete(pending))
    })
    const checkPage = async () => {
      assertActive()
      await Promise.all(pendingResponses)
      if (requestFailure) throw new Error(requestFailure)
      const body = await page.locator('body').innerText()
      if (
        /verify you are human|slide to verify|security verification|人机验证|滑动验证|访问被拒绝/i.test(
          body,
        )
      ) {
        throw new Error(
          'Qwen requires manual human verification; automatic registration cannot continue',
        )
      }
    }
    await page.goto(SIGNUP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await checkPage()
    await prepareQwenAiSignup(page, email, options.password)
    await checkPage()
    await clickQwenAiContinue(page, '发送邮箱验证码')
    // Wait for the actual code screen before asking the email service to poll.
    while (!(await page.locator(CODE_SELECTOR).first().isVisible())) {
      await checkPage()
      await page.waitForTimeout(250)
    }
    await checkPage()
    const code = (await options.resolveCode(signal))?.trim()
    assertActive()
    if (!code || !/^\d{6}$/.test(code))
      throw new Error('Qwen email verification requires a six-digit code')
    const inputs = page.locator(CODE_SELECTOR)
    // Startup creates a guest token. It must never be mistaken for the verified account.
    const previousToken = await page.evaluate(() => localStorage.getItem('token'))
    const count = await inputs.count()
    if (count === 6) {
      for (let index = 0; index < 6; index++) await inputs.nth(index).fill(code[index])
    } else if (count === 1) {
      await inputs.fill(code)
    } else {
      throw new Error('Qwen verification form changed; could not locate code inputs')
    }
    // The current OTP form submits automatically when all six cells are filled.
    // A second click waits on a disabled/disappearing button during navigation.
    if (!usesEmailOtp) await clickQwenAiContinue(page, '提交邮箱验证码')
    let token: string | null = null
    while (!token) {
      await checkPage()
      try {
        const candidate = await page.evaluate(() => localStorage.getItem('token'))
        if (candidate && candidate !== previousToken) token = candidate
      } catch (error) {
        if (page.isClosed()) throw error
        // Successful verification may navigate while reading localStorage.
      }
      if (!token) await page.waitForTimeout(250)
    }
    const credentialError = getQwenAiCredentialError(token)
    if (credentialError) throw new Error(credentialError)
    const validationResponse = await context.request.get('https://chat.qwen.ai/api/v1/auths/', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', source: 'web' },
      timeout: 15000,
    })
    let validationBody: unknown
    try {
      validationBody = await validationResponse.json()
    } catch {
      throw new Error('Invalid Qwen account validation response')
    }
    const validation = parseQwenAiAuthResponse(validationResponse.status(), validationBody)
    if (!validation.valid) throw new Error(validation.error || 'Qwen account validation failed')
    if (validation.userInfo?.email?.toLowerCase() !== email.toLowerCase()) {
      throw new Error('Qwen returned an account for a different email address')
    }
    const cookies = await context.cookies(['https://chat.qwen.ai/', 'https://auth.qwen.ai/'])
    const refreshToken = cookies.find((cookie) => cookie.name === 'refresh_token')?.value
    if (!refreshToken) throw new Error('Qwen did not issue a refresh cookie; account was not saved')
    assertActive()
    return {
      success: true,
      providerId: options.providerId,
      providerType: 'qwen-ai',
      credentials: {
        token,
        refresh_token: refreshToken,
        cookies: cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
      },
      accountInfo: validation.userInfo,
    }
  }

  try {
    return await Promise.race([run(), aborted])
  } catch (error) {
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'qwen-ai',
      error: signal.aborted
        ? options.signal.aborted
          ? 'Batch registration cancelled'
          : 'Qwen registration timed out'
        : error instanceof Error
          ? error.message
          : 'Qwen registration failed',
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    await browser
      ?.close()
      .catch((error) => console.warn('Qwen registration browser cleanup failed', error.name))
  }
}

export async function checkQwenAiRegistrationResponse(response: Response): Promise<string | null> {
  const status = response.status()
  const verify = new URL(response.url()).pathname.endsWith('/auths/otp/email/verify')
  if (status >= 400) {
    return status === 403
      ? 'Qwen blocked registration or requires manual verification'
      : `Qwen registration request failed (HTTP ${status})`
  }
  const contentType = response.headers()['content-type'] || ''
  try {
    const body = await response.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return 'Qwen 注册接口返回了无效的数据结构'
    }
    if (body.success === false || body.error || body.code || body.data?.status === false) {
      return 'Qwen rejected the email or verification code; check the inbox and try again'
    }
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      verify &&
      status === 200 &&
      /application\/json/i.test(contentType) &&
      /No resource with given identifier found|body is not available.*navigated away/i.test(message)
    ) {
      // Chromium can discard the response body as the successful login navigates.
      // Success is established later through the new token, matching identity and refresh cookie.
      console.info(
        '[QwenAI registration] Verification response body unavailable after navigation',
        { status },
      )
      return null
    }
    return /text\/html/i.test(contentType)
      ? 'Qwen 注册接口返回了网页而非 JSON，可能需要手动验证'
      : `Qwen 注册接口响应无法解析（HTTP ${status}），请稍后重试`
  }
}

/** Qwen renders auth controls before its asynchronous startup removes the splash mask. */
export async function prepareQwenAiSignup(
  page: Page,
  email: string,
  password?: string,
  readyTimeoutMs = 90000,
): Promise<void> {
  const emailInput = page.locator('input[name="email"]:visible').first()
  try {
    await emailInput.waitFor({ state: 'visible', timeout: readyTimeoutMs })
  } catch (error) {
    if (page.isClosed()) throw error
    throw new Error('Qwen 注册表单未加载完成，请检查网络后重试')
  }
  try {
    await page.locator('#splash-screen').waitFor({ state: 'hidden', timeout: readyTimeoutMs })
  } catch (error) {
    if (page.isClosed()) throw error
    throw new Error('Qwen 注册页仍被启动遮罩挡住，页面尚未加载完成，请稍后重试')
  }
  await emailInput.fill(email)
  const passwordInput = page.locator('input[type="password"]:visible')
  if (await passwordInput.count()) {
    if (!password) throw new Error('Qwen password signup requires a generated password')
    await passwordInput.fill(password)
  }
  await emailInput.press('Tab')
  // A trial checks visibility, enabled state, stability and pointer interception without submitting.
  await clickQwenAiContinue(page, '准备邮箱注册', true)
}

async function clickQwenAiContinue(page: Page, stage: string, trial = false): Promise<void> {
  const button = continueButton(page)
  try {
    await button.click({ trial })
  } catch (error) {
    if (page.isClosed()) throw error
    if (await page.locator('#splash-screen').isVisible()) {
      throw new Error(`Qwen ${stage}失败：启动遮罩仍在显示，请等待官网加载后重试`)
    }
    if (!(await button.isVisible())) {
      throw new Error(`Qwen ${stage}失败：未找到可见的继续按钮，官网表单可能已变化`)
    }
    if (!(await button.isEnabled())) {
      throw new Error(`Qwen ${stage}失败：继续按钮未启用，请检查邮箱或验证码是否有效`)
    }
    throw new Error(`Qwen ${stage}失败：继续按钮被页面元素遮挡或页面尚未就绪，请稍后重试`)
  }
}

function continueButton(page: Page) {
  return page
    .getByRole('button', { name: /^(Continue|Create Account|Verify|继续|创建账号|验证)$/i })
    .first()
}
