import axios from 'axios'
import { randomUUID } from 'node:crypto'
import type { Account } from '../../../shared/types'
import { storeManager } from '../../store/store'
import { getQwenAiCredentialError } from './auth'

export const QWEN_AI_REFRESH_URL = 'https://auth.qwen.ai/api/v2/auths/refresh'
const REFRESH_LEEWAY_SECONDS = 3 * 60

export class QwenAiRefreshError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'QwenAiRefreshError'
  }
}

export function getQwenAiJwtExpiry(token: string): number | null {
  try {
    if (token.split('.').length !== 3) return null
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    return typeof payload?.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null
  } catch {
    return null
  }
}

function cookieEntries(cookies: string): [string, string][] {
  return cookies.split(';').flatMap((part) => {
    const index = part.indexOf('=')
    const name = part.slice(0, index).trim()
    return index > 0 && name ? [[name, part.slice(index + 1).trim()] as [string, string]] : []
  })
}

export function normalizeQwenAiCredentials(
  credentials: Record<string, string>,
): Record<string, string> {
  const cookies = credentials.cookies || credentials.cookie || ''
  const refreshToken =
    credentials.refresh_token || new Map(cookieEntries(cookies)).get('refresh_token')
  return {
    ...credentials,
    ...(cookies ? { cookies } : {}),
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  }
}

export function mergeQwenAiCookies(cookies: string, setCookies: string[]): string {
  const original = cookieEntries(cookies)
  const updates = setCookies.flatMap((header) => cookieEntries(header.split(';')[0]))
  const removed = new Set(
    setCookies
      .filter((header) => {
        if (/;\s*max-age\s*=\s*0(?:;|$)/i.test(header)) return true
        const expires = /;\s*expires\s*=\s*([^;]+)/i.exec(header)?.[1]
        return expires !== undefined && Date.parse(expires) <= Date.now()
      })
      .flatMap((header) => cookieEntries(header.split(';')[0]).map(([name]) => name)),
  )
  return [...new Map([...original, ...updates])]
    .filter(([name]) => !removed.has(name))
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

export async function exchangeQwenAiRefreshToken(
  credentials: Record<string, string>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Record<string, string>> {
  const normalized = normalizeQwenAiCredentials(credentials)
  const refreshToken = normalized.refresh_token
  if (!refreshToken) {
    throw new QwenAiRefreshError('Qwen 缺少 refresh token，请补充完整 Cookies 或重新登录', 401)
  }
  const refreshExpiry = getQwenAiJwtExpiry(refreshToken)
  if (refreshExpiry !== null && refreshExpiry <= Date.now() / 1000) {
    throw new QwenAiRefreshError('Qwen 登录会话已过期，请重新登录更新 Cookies', 401)
  }
  // The official frontend authenticates this endpoint with cookies, without Bearer auth.
  const cookies = mergeQwenAiCookies(normalized.cookies || '', [`refresh_token=${refreshToken}`])
  let response
  try {
    response = await axios.get(QWEN_AI_REFRESH_URL, {
      headers: {
        Cookie: cookies,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        source: 'web',
        Version: '0.3.12',
        Origin: 'https://chat.qwen.ai',
        Referer: 'https://chat.qwen.ai/',
        'x-request-origin': 'https://chat.qwen.ai',
        'X-Request-Id': randomUUID(),
        Timezone: new Date().toString().replace(/\s*\(.+\)$/, ''),
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      },
      timeout: Math.max(1, Math.min(options.timeoutMs ?? 15000, 15000)),
      ...(options.signal ? { signal: options.signal } : {}),
      validateStatus: () => true,
      maxRedirects: 0,
    })
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason || error
    throw new QwenAiRefreshError('Qwen 自动续期请求失败，请稍后重试', 503)
  }
  const code = response.data?.data?.code
  if (
    response.status === 401 ||
    response.status === 403 ||
    (typeof code === 'string' && /unauthorized|forbidden|invalid.*token|expired.*token/i.test(code))
  ) {
    throw new QwenAiRefreshError('Qwen 登录会话失效，请重新登录更新 Cookies', 401)
  }
  const token = response.data?.data?.access_token
  if (response.status !== 200 || response.data?.success !== true || typeof token !== 'string') {
    throw new QwenAiRefreshError(`Qwen 自动续期返回无效响应（HTTP ${response.status}）`, 502)
  }
  const expiry = getQwenAiJwtExpiry(token)
  if (getQwenAiCredentialError(token) || expiry === null) {
    throw new QwenAiRefreshError('Qwen 自动续期返回无效 access token', 502)
  }
  const headers = response.headers?.['set-cookie']
  const nextCookies = mergeQwenAiCookies(
    cookies,
    Array.isArray(headers) ? headers : headers ? [headers] : [],
  )
  const nextRefresh = response.data?.data?.refresh_token
  const mergedCookies =
    typeof nextRefresh === 'string' && nextRefresh
      ? mergeQwenAiCookies(nextCookies, [`refresh_token=${nextRefresh}`])
      : nextCookies
  // Remove an obsolete explicit refresh token if Set-Cookie deleted it.
  const { refresh_token: _previousRefresh, ...preserved } = normalized
  return normalizeQwenAiCredentials({ ...preserved, token, cookies: mergedCookies })
}

const refreshFlights = new Map<string, Promise<Record<string, string>>>()

function waitForRefresh(
  flight: Promise<Record<string, string>>,
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (callback: () => void) => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      callback()
    }
    const abort = () => finish(() => reject(options.signal?.reason || new Error('Request aborted')))
    if (options.signal?.aborted) {
      abort()
      return
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(
        () => finish(() => reject(new QwenAiRefreshError('Qwen 自动续期等待超时', 504))),
        Math.max(1, options.timeoutMs),
      )
    }
    flight.then(
      (credentials) => finish(() => resolve(credentials)),
      (error) => finish(() => reject(error)),
    )
  })
}

export async function resolveQwenAiCredentials(
  account: Account,
  options: { force?: boolean; failedToken?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Record<string, string>> {
  if (options.signal?.aborted) throw options.signal.reason || new Error('Request aborted')
  const persisted = !!account.id && account.id !== 'temp'
  const current = persisted ? storeManager.getAccountById(account.id, true) || account : account
  const credentials = normalizeQwenAiCredentials(current.credentials)
  const token = credentials.token || credentials.accessToken || credentials.apiKey || ''
  const expiry = getQwenAiJwtExpiry(token)
  const now = Math.floor(Date.now() / 1000)
  if (options.failedToken && token && token !== options.failedToken) return credentials
  if (
    !options.force &&
    token &&
    !getQwenAiCredentialError(token) &&
    (expiry === null || expiry > now + REFRESH_LEEWAY_SECONDS)
  )
    return credentials
  if (!credentials.refresh_token) return credentials
  const key = `${persisted ? account.id : 'temp'}:${credentials.refresh_token}`
  let flight = refreshFlights.get(key)
  if (!flight) {
    flight = (async () => {
      let next: Record<string, string>
      try {
        // A cancelled caller must not abort renewal for other requests. Keep
        // saving rotated credentials even if every waiting request goes away.
        next = await exchangeQwenAiRefreshToken(credentials)
      } catch (error) {
        console.warn('[QwenAI] Token refresh failed', {
          accountId: account.id,
          status: error instanceof QwenAiRefreshError ? error.status : undefined,
        })
        if (persisted && error instanceof QwenAiRefreshError && error.status === 401) {
          const latest = storeManager.getAccountById(account.id, true)
          if (
            latest &&
            JSON.stringify(latest.credentials) === JSON.stringify(current.credentials)
          ) {
            storeManager.updateAccount(account.id, {
              errorMessage: error.message,
              ...(expiry !== null && expiry <= now ? { status: 'error' as const } : {}),
            })
          }
        }
        throw error
      }
      if (!persisted) return next
      const latest = storeManager.getAccountById(account.id, true)
      if (!latest) throw new QwenAiRefreshError('Qwen 账号已被删除，续期结果已取消', 401)
      if (JSON.stringify(latest.credentials) !== JSON.stringify(current.credentials)) {
        return normalizeQwenAiCredentials(latest.credentials)
      }
      if (
        !storeManager.updateAccount(account.id, {
          credentials: next,
          status: 'active',
          errorMessage: undefined,
        })
      ) {
        throw new QwenAiRefreshError('Qwen 自动续期凭据保存失败', 503)
      }
      return next
    })()
    refreshFlights.set(key, flight)
    const completedFlight = flight
    const cleanup = () => {
      if (refreshFlights.get(key) === completedFlight) refreshFlights.delete(key)
    }
    void flight.then(cleanup, cleanup)
  }
  try {
    return await waitForRefresh(flight, options)
  } catch (error) {
    // Each waiting caller decides whether its still-valid token can be used.
    if (
      !options.force &&
      error instanceof QwenAiRefreshError &&
      error.status !== 504 &&
      expiry !== null &&
      expiry > Date.now() / 1000 &&
      !options.signal?.aborted
    )
      return credentials
    throw error
  }
}
