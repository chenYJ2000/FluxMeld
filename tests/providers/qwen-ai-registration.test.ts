import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { qwenAiModule } from '../../src/main/providers/qwen-ai/index.ts'
import {
  checkQwenAiRegistrationResponse,
  prepareQwenAiSignup,
  registerQwenAiOnWeb,
} from '../../src/main/providers/qwen-ai/webRegistration.ts'

const email = 'fixture@example.test'
const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`
const html = `<!doctype html><html><body><input name="email"><button id="submit">Continue</button><script>
let stage = 0, verifying = false;
localStorage.setItem('token', 'guest-before-login');
async function verify() {
 if(verifying) return;
 verifying = true;
 const code = [...document.querySelectorAll('.qwenchat-verification-code-input-cell')].map(i=>i.value).join('');
 const response = await fetch('https://auth.qwen.ai/api/v2/auths/otp/email/verify', {method:'POST', body:code});
 const data = await response.json();
 if(data.success) localStorage.setItem('token', data.token);
}

document.querySelector('#submit').onclick = async () => {
 if (!stage) {
  const response = await fetch('https://auth.qwen.ai/api/v2/auths/otp/email/request', {method:'POST'});
  if (!(await response.json()).success) return;
  stage = 1;
  for(let i=0;i<6;i++) {const input=document.createElement('input');input.className='qwenchat-verification-code-input-cell';input.maxLength=1;input.oninput=()=>{if([...document.querySelectorAll('.qwenchat-verification-code-input-cell')].every(i=>i.value)) void verify();};document.body.append(input);}
 } else {
  await verify();
 }
};</script></body></html>`

async function fixture(
  t: any,
  settings: {
    rejected?: boolean
    wrongEmail?: boolean
    noRefresh?: boolean
    challenge?: boolean
    legacy?: boolean
    bodyUnavailable?: boolean
    rejectedVerification?: boolean
    htmlVerification?: boolean
  } = {},
) {
  const launch = chromium.launch.bind(chromium)
  const browser = await launch({ channel: 'chrome', headless: true })
  let closed = false
  let filledEmail = ''
  let filledPassword = ''
  const close = browser.close.bind(browser)
  t.mock.method(browser, 'close', async () => {
    closed = true
    await close()
  })
  t.mock.method(chromium, 'launch', async (options: any) => {
    assert.ok(options.args.includes('--no-proxy-server'))
    return browser
  })
  const newContext = browser.newContext.bind(browser)
  t.mock.method(browser, 'newContext', async (options: any) => {
    const context = await newContext(options)
    if (settings.bodyUnavailable) {
      context.on('page', (page) =>
        page.on('response', (response) => {
          if (response.url().endsWith('/auths/otp/email/verify')) {
            t.mock.method(response, 'json', async () => {
              throw new Error(
                'No resource with given identifier found. Response body is not available for a response that was navigated away from.',
              )
            })
          }
        }),
      )
    }
    await context.addCookies([
      { name: 'waf_fixture', value: 'waf-value', domain: '.qwen.ai', path: '/', secure: true },
      ...(!settings.noRefresh
        ? [
            {
              name: 'refresh_token',
              value: 'refresh-value',
              domain: '.qwen.ai',
              path: '/',
              httpOnly: true,
              secure: true,
            },
          ]
        : []),
      { name: 'unrelated', value: 'excluded', domain: 'example.test', path: '/' },
    ])
    await context.route('**/*', async (route) => {
      const url = route.request().url()
      if (url.includes('/auths/otp/email/request')) {
        const page = context.pages()[0]
        filledEmail = await page.locator('input[name="email"]').inputValue()
        if (settings.legacy)
          filledPassword = await page.locator('input[type="password"]').inputValue()
        await route.fulfill({
          headers: { 'access-control-allow-origin': '*' },
          json: { success: !settings.rejected, data: { status: !settings.rejected } },
        })
      } else if (url.includes('/auths/otp/email/verify')) {
        assert.equal(route.request().postData(), '123456')
        await route.fulfill(
          settings.htmlVerification
            ? {
                contentType: 'text/html',
                headers: { 'access-control-allow-origin': '*' },
                body: '<html>Verification required</html>',
              }
            : {
                headers: { 'access-control-allow-origin': '*' },
                json: { success: !settings.rejectedVerification, token },
              },
        )
      } else {
        const content = settings.challenge
          ? '<html><body>Verify you are human</body></html>'
          : html.replace(
              '<button id="submit">',
              `${settings.legacy ? '<input type="password">' : ''}<button id="submit">`,
            )
        await route.fulfill({ contentType: 'text/html', body: content })
      }
    })
    t.mock.method(context.request, 'get', async (url: string, options: any) => {
      assert.equal(url, 'https://chat.qwen.ai/api/v1/auths/')
      assert.equal(options.headers.Authorization, `Bearer ${token}`)
      const cookies = await context.cookies(['https://chat.qwen.ai', 'https://auth.qwen.ai'])
      assert.ok(cookies.some((cookie) => cookie.name === 'waf_fixture'))
      return {
        status: () => 200,
        json: async () => ({
          id: 'registered-user',
          role: 'user',
          email: settings.wrongEmail ? 'other@example.test' : email,
          name: 'Fixture',
        }),
      } as any
    })
    return context
  })
  t.after(async () => {
    await close()
  })
  return {
    isClosed: () => closed,
    filledEmail: () => filledEmail,
    filledPassword: () => filledPassword,
  }
}

function options(extra = {}) {
  return {
    providerId: 'qwen-ai',
    phone: '',
    email,
    countryCode: '',
    timeout: 10000,
    signal: new AbortController().signal,
    resolveCode: async () => '123456',
    ...extra,
  }
}

test('Qwen AI advertises a web registration driver and explicit signup URL', () => {
  assert.equal(qwenAiModule.config.capabilities?.webBatchRegister, true)
  assert.equal(
    qwenAiModule.registration?.registrationUrl,
    'https://chat.qwen.ai/auth?action=signup',
  )
  assert.equal(qwenAiModule.webRegistration, registerQwenAiOnWeb)
})

test('real Chrome fills all OTP digits and saves validated token, HttpOnly refresh and Qwen cookies', async (t) => {
  const browser = await fixture(t)
  const result = await registerQwenAiOnWeb(options())
  assert.equal(result.success, true, result.error)
  assert.equal(result.credentials?.token, token)
  assert.equal(result.credentials?.refresh_token, 'refresh-value')
  assert.match(result.credentials?.cookies || '', /waf_fixture=waf-value/)
  assert.match(result.credentials?.cookies || '', /refresh_token=refresh-value/)
  assert.doesNotMatch(result.credentials?.cookies || '', /unrelated/)
  assert.equal(result.accountInfo?.email, email)
  assert.equal(browser.filledEmail(), email)
  assert.ok(browser.isClosed())
})

test('legacy password form receives the generated password', async (t) => {
  const browser = await fixture(t, { legacy: true })
  const result = await registerQwenAiOnWeb(options({ password: 'Fixture-password-123' }))
  assert.equal(result.success, true, result.error)
  assert.equal(browser.filledPassword(), 'Fixture-password-123')
  assert.ok(browser.isClosed())
})

test('rejected code request fails before polling the inbox', async (t) => {
  const browser = await fixture(t, { rejected: true })
  let polled = false
  const result = await registerQwenAiOnWeb(
    options({
      resolveCode: async () => {
        polled = true
        return '123456'
      },
    }),
  )
  assert.equal(result.success, false)
  assert.match(result.error || '', /rejected/)
  assert.equal(polled, false)
  assert.ok(browser.isClosed())
})

for (const scenario of [{ noRefresh: true }, { wrongEmail: true }]) {
  test(`refuses to save incomplete or mismatched credentials ${JSON.stringify(scenario)}`, async (t) => {
    const browser = await fixture(t, scenario)
    const result = await registerQwenAiOnWeb(options())
    assert.equal(result.success, false)
    assert.equal(result.credentials, undefined)
    assert.match(result.error || '', /refresh cookie|different email/)
    assert.ok(browser.isClosed())
  })
}

test('cancellation closes Chrome even while the code resolver remains pending', async (t) => {
  const browser = await fixture(t)
  const controller = new AbortController()
  const result = await registerQwenAiOnWeb(
    options({
      signal: controller.signal,
      resolveCode: () => {
        controller.abort()
        return new Promise(() => {})
      },
    }),
  )
  assert.equal(result.success, false)
  assert.match(result.error || '', /cancelled/)
  assert.ok(browser.isClosed())
})

test('overall timeout closes Chrome while waiting for email', async (t) => {
  const browser = await fixture(t)
  const result = await registerQwenAiOnWeb(
    options({ timeout: 1500, resolveCode: () => new Promise(() => {}) }),
  )
  assert.equal(result.success, false)
  assert.match(result.error || '', /timed out/)
  assert.ok(browser.isClosed())
})

test('invalid email fails before browser launch', async (t) => {
  const launch = t.mock.method(chromium, 'launch', async () => {
    throw new Error('unexpected launch')
  })
  const result = await registerQwenAiOnWeb(options({ email: 'invalid' }))
  assert.equal(result.success, false)
  assert.match(result.error || '', /valid email/)
  assert.equal(launch.mock.calls.length, 0)
})

test('human verification stops the attempt and closes Chrome', async (t) => {
  const browser = await fixture(t, { challenge: true })
  const result = await registerQwenAiOnWeb(options())
  assert.equal(result.success, false)
  assert.match(result.error || '', /manual human verification/)
  assert.equal(result.credentials, undefined)
  assert.ok(browser.isClosed())
})

test('missing email code returns no credentials', async (t) => {
  const browser = await fixture(t)
  const result = await registerQwenAiOnWeb(options({ resolveCode: async () => null }))
  assert.equal(result.success, false)
  assert.match(result.error || '', /six-digit code/)
  assert.equal(result.credentials, undefined)
  assert.ok(browser.isClosed())
})

test('waits for Qwen startup mask to disappear before filling the controlled form', async (t) => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent(`<style>#splash-screen {position:fixed;inset:0;z-index:999999;background:white}</style>
    <input name="email"><button disabled>Continue</button><div id="splash-screen">Loading</div>
    <script>
    document.querySelector('input').addEventListener('input', () => {
      if (document.querySelector('#splash-screen')) document.body.dataset.filledEarly = 'true';
      document.querySelector('button').disabled = !document.querySelector('input').value.includes('@');
    });
    setTimeout(() => document.querySelector('#splash-screen').remove(), 250);
    </script>`)
  await prepareQwenAiSignup(page, email, undefined, 2000)
  assert.equal(await page.locator('body').getAttribute('data-filled-early'), null)
  assert.equal(await page.locator('input').inputValue(), email)
  assert.equal(await page.locator('button').isEnabled(), true)
  assert.equal(await page.locator('#splash-screen').count(), 0)
})

test('a persistent Qwen startup mask produces a clear error without filling or submitting', async (t) => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent(`<style>#splash-screen {position:fixed;inset:0;z-index:999999;background:white}</style>
    <input name="email"><button>Continue</button><div id="splash-screen">Loading</div>`)
  await assert.rejects(prepareQwenAiSignup(page, email, undefined, 100), /启动遮罩/)
  assert.equal(await page.locator('input').inputValue(), '')
})

test('successful automatic OTP verification survives an unavailable response body and ignores the startup guest token', async (t) => {
  const browser = await fixture(t, { bodyUnavailable: true })
  const result = await registerQwenAiOnWeb(options())
  assert.equal(result.success, true, result.error)
  assert.equal(result.credentials?.token, token)
  assert.notEqual(result.credentials?.token, 'guest-before-login')
  assert.ok(browser.isClosed())
})

for (const scenario of [{ rejectedVerification: true }, { htmlVerification: true }]) {
  test(`verification errors still fail safely ${JSON.stringify(scenario)}`, async (t) => {
    const browser = await fixture(t, scenario)
    const result = await registerQwenAiOnWeb(options())
    assert.equal(result.success, false)
    assert.equal(result.credentials, undefined)
    assert.match(result.error || '', /rejected|网页而非 JSON/)
    assert.ok(browser.isClosed())
  })
}

test('only the known navigation body loss for a JSON verification success is tolerated', async () => {
  const response = (path: string, status: number, type: string, message: string) =>
    ({
      url: () => `https://auth.qwen.ai/api/v2/auths/otp/email/${path}`,
      status: () => status,
      headers: () => ({ 'content-type': type }),
      json: async () => {
        throw new Error(message)
      },
    }) as any
  assert.equal(
    await checkQwenAiRegistrationResponse(
      response('verify', 200, 'application/json', 'No resource with given identifier found'),
    ),
    null,
  )
  assert.match(
    (await checkQwenAiRegistrationResponse(
      response('request', 200, 'application/json', 'No resource with given identifier found'),
    )) || '',
    /无法解析/,
  )
  assert.match(
    (await checkQwenAiRegistrationResponse(
      response('verify', 200, 'application/json', 'Unexpected token'),
    )) || '',
    /无法解析/,
  )
  assert.match(
    (await checkQwenAiRegistrationResponse(
      response('verify', 401, 'application/json', 'No resource with given identifier found'),
    )) || '',
    /HTTP 401/,
  )
  assert.match(
    (await checkQwenAiRegistrationResponse(
      response('verify', 200, 'text/html', 'No resource with given identifier found'),
    )) || '',
    /网页而非 JSON/,
  )
})
