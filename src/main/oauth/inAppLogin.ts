/**
 * In-App Login Manager
 * Manages in-app browser window for OAuth login and token extraction
 */

import { BrowserWindow, session, Session } from 'electron'
import { EventEmitter } from 'events'
import { ProviderType } from './types'
import {
  TokenExtractionConfig,
  getTokenExtractionConfig,
  TokenSource,
} from './tokenExtractionConfig'
import type { RegistrationConfig } from '../providers/types.ts'

export interface InAppLoginResult {
  success: boolean
  credentials?: Record<string, string>
  error?: string
}

export interface TokenFoundEvent {
  key: string
  value: string
}

export interface InAppLoginOptions {
  providerId: string
  providerType: ProviderType
  timeout?: number
  proxyMode?: 'system' | 'none'
  /**
   * `register` opens the provider's registration page and prefills the form
   * instead of the normal login page. Credential sniffing is identical.
   */
  mode?: 'login' | 'register'
  /** Values injected into the registration form (phone/email + password). */
  prefill?: { phone?: string; email?: string; password?: string }
  /** Explicit registration rules from the provider module. */
  registration?: RegistrationConfig | null
  /**
   * Optional resolver for the SMS verification code. Called once when the
   * registration page loads; when it resolves with a code the code field is
   * filled automatically. Resolve with `null` to leave it to the operator.
   */
  codeResolver?: () => Promise<string | null>
}

const DEFAULT_TIMEOUT = 300000 // 5 minutes
const MIN_LOGIN_TIME = 5000 // Minimum time before checking tokens (5 seconds)

export class InAppLoginManager extends EventEmitter {
  private loginWindow: BrowserWindow | null = null
  private loginSession: Session | null = null
  private foundTokens: Map<string, string> = new Map()
  private config: TokenExtractionConfig | null = null
  private isCompleted: boolean = false
  private timeoutId: NodeJS.Timeout | null = null
  /** Fallback timer that reveals the window even without `ready-to-show`. */
  private revealTimer: NodeJS.Timeout | null = null
  private resolvePromise: ((result: InAppLoginResult) => void) | null = null
  private loginStartTime: number = 0
  private lastTokenCheckTime: number = 0
  private options: InAppLoginOptions | null = null
  private resolvedCode: string | null = null
  private codeResolutionStarted: boolean = false
  private tokenCheckInterval: NodeJS.Timeout | null = null

  constructor() {
    super()
  }

  async startLogin(options: InAppLoginOptions): Promise<InAppLoginResult> {
    if (this.loginWindow) {
      return {
        success: false,
        error: 'A login window is already open',
      }
    }

    this.config = getTokenExtractionConfig(options.providerType)
    if (!this.config) {
      return {
        success: false,
        error: `No token extraction config found for provider: ${options.providerType}`,
      }
    }

    this.foundTokens.clear()
    this.isCompleted = false
    this.loginStartTime = Date.now()
    this.lastTokenCheckTime = 0
    this.options = options
    this.resolvedCode = null
    this.codeResolutionStarted = false

    return new Promise((resolve) => {
      this.resolvePromise = resolve

      this.timeoutId = setTimeout(() => {
        this.complete({
          success: false,
          error: 'Login timeout',
        })
      }, options.timeout || DEFAULT_TIMEOUT)

      this.emit('status', { status: 'starting', message: 'Opening login window...' })

      this.createLoginWindow()
      this.setupTokenInterception()
    })
  }

  private createLoginWindow(): void {
    if (!this.config) return

    const partition = `persist:oauth-${Date.now()}`
    this.loginSession = session.fromPartition(partition)

    if (this.options?.proxyMode === 'none') {
      this.loginSession.setProxy({ mode: 'direct' }).catch((error) => {
        console.error('[InAppLogin] Failed to set direct proxy:', error)
      })
    }

    this.loginWindow = new BrowserWindow({
      width: 500,
      height: 700,
      show: false,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition,
        webSecurity: true,
        javascript: true,
      },
      title: this.resolveWindowTitle(),
      autoHideMenuBar: true,
    })

    // Some SPAs never emit `ready-to-show` (heavy bundles, in-page auth overlays,
    // slow first paint). Reveal on the first load event and also on a timer so
    // the operator is never left with an invisible window.
    const revealWindow = () => {
      if (!this.loginWindow || this.loginWindow.isDestroyed()) return
      // Always (re)assert stacking + focus; a plain `isVisible()` guard would
      // skip this when the window was created but opened behind the main window.
      if (!this.loginWindow.isVisible()) {
        this.loginWindow.show()
      }
      this.loginWindow.center()
      this.loginWindow.setAlwaysOnTop(true, 'screen-saver')
      this.loginWindow.moveTop()
      this.loginWindow.restore?.()
      this.loginWindow.focus()
      const bounds = this.loginWindow.getBounds()
      console.log('[InAppLogin] Revealed registration/login window', {
        url: this.loginWindow.webContents.getURL(),
        visible: this.loginWindow.isVisible(),
        bounds,
      })
      this.emit('status', { status: 'ready', message: 'Login window ready - please log in' })
    }
    this.loginWindow.webContents.once('did-finish-load', revealWindow)
    this.loginWindow.webContents.once('did-fail-load', revealWindow)
    this.loginWindow.once('ready-to-show', revealWindow)
    this.revealTimer = setTimeout(revealWindow, 8000)
    console.log('[InAppLogin] Registration window created, target:', this.resolveTargetUrl())

    this.loginWindow.on('closed', () => {
      if (!this.isCompleted) {
        this.complete({
          success: false,
          error: 'Login window was closed',
        })
      }
    })

    this.loginWindow.loadURL(this.resolveTargetUrl()).catch((error) => {
      this.complete({
        success: false,
        error: `Failed to load login page: ${error.message}`,
      })
    })
  }

  private isRegistrationMode(): boolean {
    return this.options?.mode === 'register' && !!this.options.registration
  }

  private resolveTargetUrl(): string {
    if (this.isRegistrationMode()) {
      return this.options!.registration!.registrationUrl
    }
    return this.config?.loginUrl || ''
  }

  private resolveWindowTitle(): string {
    if (this.isRegistrationMode()) {
      return this.options!.registration!.windowTitle || 'Register'
    }
    return this.config?.windowTitle || 'Login'
  }

  private setupTokenInterception(): void {
    if (!this.loginSession || !this.config) return

    // Intercept response headers to capture Set-Cookie headers
    // This is needed for HttpOnly + Secure cookies that may not be accessible via cookies.get()
    this.loginSession.webRequest.onHeadersReceived((details, callback) => {
      if (this.isCompleted) {
        callback({})
        return
      }

      const setCookieHeaders =
        details.responseHeaders?.['set-cookie'] || details.responseHeaders?.['Set-Cookie']
      if (setCookieHeaders && Array.isArray(setCookieHeaders)) {
        console.log('[InAppLogin] Received Set-Cookie headers:', setCookieHeaders.length)
        for (const cookieHeader of setCookieHeaders) {
          const cookieParts = cookieHeader.split(';')
          const nameValue = cookieParts[0]?.trim()
          if (nameValue) {
            const equalIndex = nameValue.indexOf('=')
            if (equalIndex > 0) {
              const name = nameValue.substring(0, equalIndex)
              let value = nameValue.substring(equalIndex + 1)

              // Remove surrounding quotes from the value (RFC 6265 allows quoted cookie values)
              if (value.startsWith('"') && value.endsWith('"')) {
                value = value.slice(1, -1)
                console.log('[InAppLogin] Removed quotes from cookie value:', name)
              }

              for (const source of this.config!.tokenSources) {
                if (source.type === 'cookie' && name === source.key) {
                  console.log('[InAppLogin] Found target cookie in Set-Cookie header:', name)
                  if (this.isValidToken(value)) {
                    console.log('[InAppLogin] Cookie token is valid from Set-Cookie header')
                    this.emitTokenFound({ key: source.key, value: value })
                  }
                }
              }
            }
          }
        }
      }

      callback({})
    })

    this.loginSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (this.isCompleted) {
        callback({ requestHeaders: details.requestHeaders })
        return
      }

      if (!this.hasMinTimePassed()) {
        callback({ requestHeaders: details.requestHeaders })
        return
      }

      const authHeader =
        details.requestHeaders['Authorization'] || details.requestHeaders['authorization']
      if (authHeader) {
        for (const source of this.config!.tokenSources) {
          if (source.type === 'networkHeader') {
            let token = authHeader
            if (source.extractPattern) {
              const match = authHeader.match(new RegExp(source.extractPattern))
              if (match && match[1]) {
                token = match[1]
              }
            } else if (authHeader.startsWith('Bearer ')) {
              token = authHeader.substring(7)
            }
            if (this.isValidToken(token)) {
              this.emitTokenFound({ key: source.key, value: token })
            }
          }
        }
      }

      callback({ requestHeaders: details.requestHeaders })
    })

    this.loginSession.cookies.on('changed', async (_event, cookie, _cause, removed) => {
      if (this.isCompleted || removed) return

      // Only react to cookies that can actually carry a credential. Anti-bot
      // cookies (e.g. ssxmod_itna) churn constantly and would otherwise trigger
      // an endless token-rescan loop.
      const isTargetCookie = this.config!.tokenSources.some(
        (source) => source.type === 'cookie' && source.key === cookie.name,
      )
      if (!isTargetCookie) return

      console.log('[InAppLogin] Target cookie changed:', cookie.name)

      if (!this.hasMinTimePassed()) {
        console.log('[InAppLogin] Min time not passed, skipping cookie check')
        return
      }

      for (const source of this.config!.tokenSources) {
        if (source.type === 'cookie' && cookie.name === source.key) {
          console.log('[InAppLogin] Cookie matches source key:', source.key)
          if (this.isValidToken(cookie.value)) {
            console.log('[InAppLogin] Cookie token is valid, emitting tokenFound')
            this.emitTokenFound({ key: source.key, value: cookie.value })
          } else {
            console.log('[InAppLogin] Cookie token is invalid:', source.key)
          }
        }
      }

      console.log('[InAppLogin] Checking all cookies after change')
      await this.checkForTokens()
    })

    this.loginWindow?.webContents.on('did-finish-load', () => {
      console.log('[InAppLogin] Page finished loading, starting token checks')
      this.injectRegistrationAutofill()
      this.startCodeResolution()
      this.delayedTokenCheck()
    })

    this.loginWindow?.webContents.on('did-navigate-in-page', () => {
      console.log('[InAppLogin] Page navigated, starting delayed token check')
      this.injectRegistrationAutofill()
      this.delayedTokenCheck()
    })

    // Registration forms frequently render in late-loading iframes (Aliyun
    // passport, etc). Re-inject whenever any frame finishes so the autofill
    // reaches the field once it exists.
    this.loginWindow?.webContents.on('did-frame-finish-load', () => {
      this.injectRegistrationAutofill()
    })

    // Some login pages update Local Storage without navigating. Keep checking
    // until the credentials are found or the login window closes.
    if (this.config.tokenSources.some((source) => source.type === 'localStorage')) {
      this.tokenCheckInterval = setInterval(() => {
        if (this.isCompleted || !this.hasMinTimePassed()) return
        void this.checkForTokens()
      }, 2000)
    }
  }

  /**
   * Resolve the SMS verification code through the provider-supplied resolver
   * and inject it into the page once available. Runs at most once per window.
   */
  private startCodeResolution(): void {
    const resolver = this.options?.codeResolver
    if (!this.isRegistrationMode() || !resolver || this.codeResolutionStarted) return
    this.codeResolutionStarted = true

    resolver()
      .then((code) => {
        if (this.isCompleted || !code) return
        this.resolvedCode = code
        console.log('[InAppLogin] Verification code resolved, injecting into form')
        this.injectRegistrationAutofill()
      })
      .catch((error) => {
        console.error('[InAppLogin] Code resolver failed:', error)
      })
  }

  /**
   * Inject a self-refreshing autofill script into the registration page.
   *
   * The page is a multi-step SPA: the phone field appears first and the
   * password field may only appear after the SMS step. A MutationObserver
   * inside the page keeps filling whichever fields become available, but only
   * when they are still empty so the human's own input is never overwritten.
   */
  private injectRegistrationAutofill(): void {
    if (!this.isRegistrationMode()) return
    if (!this.loginWindow || this.loginWindow.isDestroyed()) return
    if (this.loginWindow.webContents.isDestroyed()) return

    const prefill = this.options?.prefill || {}
    const fields = this.options?.registration?.fields || [
      { value: 'phone' as const },
      { value: 'password' as const },
    ]
    const phoneField = fields.find((f) => f.value === 'phone')
    const emailField = fields.find((f) => f.value === 'email')
    const passwordField = fields.find((f) => f.value === 'password')
    const codeField = fields.find((f) => f.value === 'code')

    const payload = {
      phone: phoneField ? prefill.phone : undefined,
      email: emailField ? prefill.email : undefined,
      password: passwordField ? prefill.password : undefined,
      code: this.resolvedCode || undefined,
      phoneSelector: phoneField?.selector,
      emailSelector: emailField?.selector,
      passwordSelector: passwordField?.selector,
      codeSelector: codeField?.selector,
      codeSegmentedSelector: this.options?.registration?.codeSegmentedSelector,
      termsCheckboxSelector: this.options?.registration?.termsCheckboxSelector,
      sendCodeSelector: this.options?.registration?.sendCodeSelector,
      submitSelector: this.options?.registration?.submitSelector,
      activateTabText: this.options?.registration?.activateTabText,
    }

    if (!payload.phone && !payload.email && !payload.password && !payload.code) return

    const script = `(() => {
      const payload = ${JSON.stringify(payload)};
      const done = { phone: false, email: false, password: false, code: false };

      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };

      const setValue = (el, value) => {
        try {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, value); else el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
          return true;
        } catch (e) {
          return false;
        }
      };

      const visibleInputs = () =>
        Array.from(document.querySelectorAll('input, textarea')).filter(isVisible);

      const hint = (el) =>
        [el.placeholder, el.getAttribute('aria-label'), el.name, el.id, el.type]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

      const findPhone = () => {
        if (payload.phoneSelector) {
          const el = document.querySelector(payload.phoneSelector);
          if (el && isVisible(el)) return el;
        }
        const tel = document.querySelector('input[type="tel"]');
        if (tel && isVisible(tel)) return tel;
        const hinted = visibleInputs().find((el) => /(手机号|手机|电话|phone|mobile)/.test(hint(el)));
        if (hinted) return hinted;
        return visibleInputs().find(
          (el) => el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'tel') && el.maxLength === 11,
        ) || null;
      };

      const findEmail = () => {
        if (payload.emailSelector) {
          const el = document.querySelector(payload.emailSelector);
          if (el && isVisible(el)) return el;
        }
        const mail = document.querySelector('input[type="email"]');
        if (mail && isVisible(mail)) return mail;
        const hinted = visibleInputs().find((el) =>
          /(邮箱|邮件|email|e-mail|mail)/.test(hint(el)),
        );
        return hinted || null;
      };

      const findPassword = () => {        if (payload.passwordSelector) {
          const el = document.querySelector(payload.passwordSelector);
          if (el && isVisible(el)) return el;
        }
        return visibleInputs().find((el) => el.type === 'password') || null;
      };

      const findCode = () => {
        if (payload.codeSelector) {
          const el = document.querySelector(payload.codeSelector);
          if (el && isVisible(el)) return el;
        }
        const hinted = visibleInputs().find((el) =>
          /(验证码|校验码|verification|\\bcode\\b)/.test(hint(el)),
        );
        if (hinted) return hinted;
        return (
          visibleInputs().find(
            (el) =>
              el.tagName === 'INPUT' &&
              (el.type === 'text' || el.type === 'number' || el.inputMode === 'numeric') &&
              el.maxLength >= 4 &&
              el.maxLength <= 6,
          ) || null
        );
      };

      const getVal = (el) => (el && typeof el.value === 'string' ? el.value : '');

      // Some providers render the code as one box per digit (e.g. Qwen AI uses
      // qwenchat-verification-code-inp elements). Detect that and fill each box.
      const findCodeBoxes = () => {
        if (payload.codeSegmentedSelector) {
          const nodes = Array.from(document.querySelectorAll(payload.codeSegmentedSelector)).filter(isVisible);
          if (nodes.length >= 2) return nodes;
        }
        const hinted = visibleInputs().filter((el) => el.className && /code-?(inp|box|cell|input)|otp-?(inp|box|cell)|pin-?(inp|box|cell)|verification-code/i.test(el.className));
        return hinted.length >= 2 ? hinted : [];
      };

      const fillSegmentedCode = (boxes, value) => {
        if (!boxes || boxes.length < 2) return false;
        const digits = String(value).replace(/\\D/g, '');
        if (digits.length < boxes.length) return false;
        for (let i = 0; i < boxes.length; i++) {
          const box = boxes[i];
          if (!box) continue;
          box.focus();
          const proto = HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(box, digits[i]); else box.value = digits[i];
          box.dispatchEvent(new Event('input', { bubbles: true }));
          box.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      };

      const tick = () => {
        try {
          // Activate the declared tab (e.g. Aliyun "手机号登录") until the phone
          // field is present, so the form we fill is the one actually shown.
          if (payload.activateTabText && !done.phone && !findPhone()) {
            const want = payload.activateTabText;
            const tab = [...document.querySelectorAll('div,span,a,li,button')].find(
              (n) => (n.textContent || '').trim() === want && n.children.length === 0,
            );
            if (tab) tab.click();
          }
          if (payload.phone && !done.phone) {
            const el = findPhone();
            if (el && !el.value && setValue(el, payload.phone)) {
              done.phone = true;
              return;
            }
          }
          if (payload.email && !done.email) {
            const el = findEmail();
            if (el && !el.value && setValue(el, payload.email)) {
              done.email = true;
              return;
            }
          }
          if (payload.password && !done.password) {
            const el = findPassword();
            if (el && !el.value && setValue(el, payload.password)) done.password = true;
          }
          const terms = payload.termsCheckboxSelector
            ? document.querySelector(payload.termsCheckboxSelector)
            : null;
          if (terms && isVisible(terms) && !terms.checked) {
            terms.click();
            return;
          }

          const phoneEl = findPhone();
          const emailEl = findEmail();
          const codeEl = findCode();
          const send = payload.sendCodeSelector
            ? document.querySelector(payload.sendCodeSelector)
            : null;
          if (payload.sendCodeSelector && !window.__fluxmeldRegSendClicked) {
            // The input value may read empty on controlled inputs even after we
            // set it, so treat "we already filled it" as sufficient.
            const targetReady =
              (!!phoneEl && (!!getVal(phoneEl) || done.phone)) ||
              (!!emailEl && (!!getVal(emailEl) || done.email));
            if (send && targetReady && !getVal(codeEl) && !send.disabled &&
                (!payload.termsCheckboxSelector || terms?.checked)) {
              window.__fluxmeldRegSendClicked = true;
              send.click();
              return;
            }
          }

          if (payload.code && !done.code) {
            // Segmented boxes (one digit each) first, then a single input.
            const boxes = findCodeBoxes();
            if (boxes.length >= 2) {
              if (fillSegmentedCode(boxes, payload.code)) {
                done.code = true;
                return;
              }
            } else if (codeEl && !getVal(codeEl) && setValue(codeEl, payload.code)) {
              done.code = true;
              return;
            }
          }

          const submit = payload.submitSelector
            ? document.querySelector(payload.submitSelector)
            : null;
          if (submit && payload.code && getVal(codeEl) === payload.code && !submit.disabled && !window.__fluxmeldRegSubmitted) {
            window.__fluxmeldRegSubmitted = true;
            submit.click();
          }
        } catch (e) {}
      };

      tick();

      if (window.__fluxmeldRegObserver) window.__fluxmeldRegObserver.disconnect();
      try {
        const observer = new MutationObserver(() => tick());
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.__fluxmeldRegObserver = observer;
      } catch (e) {}
      if (window.__fluxmeldRegInterval) clearInterval(window.__fluxmeldRegInterval);
      window.__fluxmeldRegInterval = setInterval(tick, 1500);
    })()`

    // The registration form often lives inside a cross-origin iframe (e.g.
    // Aliyun passport embeds the phone/code inputs in `passport.aliyun.com`).
    // Inject into every frame so the autofill can reach it; evaluating in the
    // top frame alone finds none of those inputs.
    const wc = this.loginWindow.webContents
    const frames = (() => {
      try {
        return wc.mainFrame.framesInSubtree
      } catch {
        return [wc.mainFrame]
      }
    })()

    for (const frame of frames) {
      frame.executeJavaScript(script).catch(() => {
        // Cross-origin frames that reject injection are expected; ignore.
      })
    }
  }

  private hasMinTimePassed(): boolean {
    return Date.now() - this.loginStartTime >= MIN_LOGIN_TIME
  }

  private delayedTokenCheck(): void {
    const now = Date.now()
    if (now - this.lastTokenCheckTime < 2000) return
    this.lastTokenCheckTime = now

    setTimeout(() => {
      if (this.isCompleted) return
      if (!this.loginWindow || this.loginWindow.isDestroyed()) return
      if (this.loginWindow.webContents.isDestroyed()) return
      if (this.hasMinTimePassed()) {
        this.checkForTokens()
      }
    }, 1000)
  }

  private isValidToken(value: string): boolean {
    console.log('[InAppLogin] Checking token validity, length:', value.length)

    if (!value || value.length < 5) {
      console.log('[InAppLogin] Token rejected: too short or empty')
      return false
    }

    // Check for JWT format (3 parts) or JWE format (5 parts)
    if (value.startsWith('eyJ')) {
      const parts = value.split('.')

      // JWE format (5 parts) - used by Perplexity and some other providers
      if (parts.length === 5) {
        console.log('[InAppLogin] Token appears to be JWE format (5 parts)')
        // JWE tokens are encrypted, we can't decode them, but they're valid if properly formatted
        if (value.length >= 100) {
          console.log('[InAppLogin] Token accepted as valid JWE')
          return true
        }
        console.log('[InAppLogin] JWE token rejected: too short')
        return false
      }

      // JWT format (3 parts)
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())

          // Reject guest accounts
          if (payload.email && payload.email.includes('@guest.com')) {
            console.log('[InAppLogin] Token rejected: guest account')
            return false
          }

          if (
            payload &&
            (payload.app_id ||
              payload.sub ||
              payload.exp ||
              payload.id ||
              payload.user_id ||
              payload.uid ||
              payload.email)
          ) {
            console.log('[InAppLogin] Token accepted as valid JWT')
            return true
          }
        } catch {
          console.log('[InAppLogin] Token rejected: invalid JWT')
          return false
        }
      }
    }

    // Accept long tokens (>= 64 chars) - includes base64 chars like / + and *
    if (value.length >= 64 && /^[a-zA-Z0-9_\-+/*]+$/.test(value)) {
      console.log('[InAppLogin] Token accepted as long token')
      return true
    }

    // Accept medium tokens (32-63 chars) - includes base64 chars and *
    if (value.length >= 32 && value.length < 64 && /^[a-zA-Z0-9_\-+/*]+$/.test(value)) {
      console.log('[InAppLogin] Token accepted as medium token')
      return true
    }

    // Accept Base64-encoded tokens (may contain = padding and /)
    // This handles tokens like "SME5/AEwvmtjSu4XO18SYg=="
    if (value.length >= 20 && /^[a-zA-Z0-9_\-+/]+=*$/.test(value)) {
      console.log('[InAppLogin] Token accepted as Base64 token')
      return true
    }

    // Accept any token that looks like a valid string (at least 5 chars, no spaces)
    // This handles short tokens like userId
    if (value.length >= 5 && !/\s/.test(value)) {
      console.log('[InAppLogin] Token accepted as generic token')
      return true
    }

    console.log('[InAppLogin] Token rejected: does not match any pattern')
    return false
  }

  private async checkForTokens(): Promise<void> {
    if (!this.loginWindow || this.isCompleted || !this.config) return

    if (this.loginWindow.isDestroyed()) {
      console.log('[InAppLogin] Window is destroyed, skipping token check')
      return
    }

    const webContents = this.loginWindow.webContents
    if (webContents.isDestroyed()) {
      console.log('[InAppLogin] webContents is destroyed, skipping token check')
      return
    }

    const localStorageSources = this.config.tokenSources.filter((s) => s.type === 'localStorage')
    const cookieSources = this.config.tokenSources.filter((s) => s.type === 'cookie')

    if (localStorageSources.length === 0 && cookieSources.length === 0) return

    console.log(
      '[InAppLogin] Checking tokens, localStorage:',
      localStorageSources.map((s) => s.key),
      'cookies:',
      cookieSources.map((s) => s.key),
    )

    try {
      for (const source of localStorageSources) {
        if (webContents.isDestroyed() || this.isCompleted) {
          console.log('[InAppLogin] webContents destroyed or login completed, stopping token check')
          return
        }
        const script = `
          (function() {
            try {
              const value = localStorage.getItem('${source.key}');
              return value || null;
            } catch (e) {
              console.error('[InAppLogin] Error reading localStorage:', e);
              return null;
            }
          })()
        `
        const value = await webContents.executeJavaScript(script)
        console.log('[InAppLogin] Read localStorage token source:', {
          key: source.key,
          present: typeof value === 'string' && value.length > 0,
          length: typeof value === 'string' ? value.length : 0,
        })

        if (source.key === 'user_detail_agent' && value) {
          try {
            const parsed = JSON.parse(value)
            const realUserID = parsed.realUserID || parsed.id
            if (realUserID) {
              console.log('[InAppLogin] Found realUserID from user_detail_agent')
              this.emitTokenFound({ key: 'realUserID', value: String(realUserID) })
            }
          } catch (e) {
            console.error('[InAppLogin] Error parsing user_detail_agent:', e)
          }
          continue
        }

        let tokenValue = value
        if (value && value.startsWith('{') && value.endsWith('}')) {
          try {
            const parsed = JSON.parse(value)
            if (parsed.value) {
              tokenValue = parsed.value
              console.log('[InAppLogin] Extracted token from JSON wrapper')
            }
          } catch (e) {
            console.error('[InAppLogin] Error parsing JSON token:', e)
          }
        }

        if (tokenValue && typeof tokenValue === 'string' && this.isValidToken(tokenValue)) {
          console.log('[InAppLogin] Token found and valid from localStorage:', source.key)
          const emitKey = source.key === '_token' ? 'token' : source.key
          this.emitTokenFound({ key: emitKey, value: tokenValue })
        }
      }

      for (const source of cookieSources) {
        if (!this.loginSession) continue

        const allCookies = await this.loginSession.cookies.get({})
        console.log('[InAppLogin] All cookies count:', allCookies.length)
        console.log(
          '[InAppLogin] All cookie names:',
          allCookies.map((c) => c.name),
        )

        const targetDomains = this.config?.targetDomains || []
        let cookiesToSearch = allCookies

        for (const domain of targetDomains) {
          try {
            const domainCookies = await this.loginSession.cookies.get({ domain })
            console.log(
              `[InAppLogin] Domain cookies for ${domain}:`,
              domainCookies.map((c) => c.name),
            )
            for (const dc of domainCookies) {
              if (!cookiesToSearch.find((c) => c.name === dc.name)) {
                cookiesToSearch.push(dc)
              }
            }
          } catch (e) {
            console.log(`[InAppLogin] Error getting cookies for domain ${domain}:`, e)
          }
        }

        console.log(
          '[InAppLogin] Combined cookies to search:',
          cookiesToSearch.map((c) => c.name),
        )

        const cookie = cookiesToSearch.find((c) => c.name === source.key)
        if (cookie) {
          console.log('[InAppLogin] Found cookie:', source.key)

          if (cookie.value && this.isValidToken(cookie.value)) {
            console.log(
              '[InAppLogin] Token found and valid from cookie:',
              source.key,
              'emitting tokenFound event',
            )
            const allCookiesObj: Record<string, string> = {}
            for (const c of cookiesToSearch) {
              if (c.value) {
                allCookiesObj[c.name] = c.value
              }
            }
            this.emitTokenFound({
              key: source.key,
              value: cookie.value,
              allCookies: allCookiesObj,
            })
          } else {
            console.log('[InAppLogin] Cookie token is invalid:', source.key)
          }
        } else {
          console.log('[InAppLogin] Cookie not found:', source.key)
        }
      }
    } catch (error) {
      console.error('[InAppLogin] Error in checkForTokens:', error)
    }
  }

  completeWithSuccess(credentials: Record<string, string>): void {
    this.complete({
      success: true,
      credentials,
    })
  }

  /**
   * Emit a found token, attaching the full browser cookie jar when the provider
   * requests it (`tokenExtraction.collectCookies`). Some APIs reject requests
   * that carry a valid token but lack the site's anti-bot cookies.
   */
  private async emitTokenFound(event: {
    key: string
    value: string
    allCookies?: Record<string, string>
  }): Promise<void> {
    let allCookies = event.allCookies

    if (!allCookies && this.config?.collectCookies && this.loginSession) {
      allCookies = await this.collectCookieJar()
    }

    this.emit('tokenFound', allCookies ? { ...event, allCookies } : event)
  }

  /** Build a `name -> value` map of the session's cookies for target domains. */
  private async collectCookieJar(): Promise<Record<string, string>> {
    const jar: Record<string, string> = {}
    if (!this.loginSession) return jar

    try {
      const all = await this.loginSession.cookies.get({})
      const seen = new Set<string>()
      for (const cookie of all) {
        if (cookie.value) {
          jar[cookie.name] = cookie.value
          seen.add(cookie.name)
        }
      }
      for (const domain of this.config?.targetDomains || []) {
        try {
          const domainCookies = await this.loginSession.cookies.get({ domain })
          for (const cookie of domainCookies) {
            if (cookie.value && !seen.has(cookie.name)) {
              jar[cookie.name] = cookie.value
              seen.add(cookie.name)
            }
          }
        } catch {
          // Ignore domains the session cannot query.
        }
      }
    } catch (error) {
      console.error('[InAppLogin] Failed to collect cookie jar:', error)
    }

    return jar
  }

  private complete(result: InAppLoginResult): void {
    if (this.isCompleted) return
    this.isCompleted = true

    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
    if (this.revealTimer) {
      clearTimeout(this.revealTimer)
      this.revealTimer = null
    }
    if (this.tokenCheckInterval) {
      clearInterval(this.tokenCheckInterval)
      this.tokenCheckInterval = null
    }

    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.close()
    }

    this.cleanup()

    if (this.resolvePromise) {
      this.resolvePromise(result)
      this.resolvePromise = null
    }

    this.emit('complete', result)
  }

  private cleanup(): void {
    if (this.loginSession) {
      try {
        this.loginSession.webRequest.onBeforeSendHeaders(() => {})
        this.loginSession.cookies.removeAllListeners()
      } catch (error) {
        console.error('[InAppLogin] Error cleaning up session:', error)
      }
      this.loginSession = null
    }

    this.loginWindow = null
    this.config = null
  }

  cancel(): void {
    if (!this.isCompleted) {
      this.complete({
        success: false,
        error: 'Login cancelled by user',
      })
    }
  }

  isWindowOpen(): boolean {
    return this.loginWindow !== null && !this.loginWindow.isDestroyed()
  }

  destroy(): void {
    this.cancel()
    this.removeAllListeners()
  }
}

export const inAppLoginManager = new InAppLoginManager()

export default InAppLoginManager
