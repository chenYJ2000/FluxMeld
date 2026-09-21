/**
 * Company phone-verification API client (xbsms.work-compatible).
 *
 * Endpoints (relative to `<baseUrl>/api/external`):
 *   getPhone  -> lease a phone number
 *                params: token, keyWord, [province], [cardType]
 *                plain text: `19337953958`
 *   getMsg    -> fetch the raw SMS content
 *                params: token, phone, keyWord
 *                plain text: `【抖音】验证码123456，请在10分钟内填写。`
 *   getCode   -> optional direct code endpoint (same params as getMsg)
 *   release   -> release a leased number     params: token, phone -> `ok`
 *   block     -> blacklist a number          params: token, phone -> `ok`
 *
 * Authentication is `?token=sk_live_...` (default) or
 * `Authorization: Bearer sk_live_...`.
 *
 * Responses are plain text. Failures are returned as `ERROR:<message>` with an
 * HTTP 2xx status, so business errors are detected from the body as well as
 * from non-2xx status codes.
 *
 * The documented rate limit is 1 request / 1.5s, so every call goes through a
 * shared throttle and 429 / "请求过于频繁" responses are retried using
 * `Retry-After` when present.
 *
 * Phone numbers are handled exclusively in the main process and never sent to
 * the renderer.
 */

import axios from 'axios'
import { randomInt } from 'crypto'
import type { RegistrationApiConfig } from '../../shared/types'

const REQUEST_TIMEOUT_MS = 15000
const DEFAULT_MIN_INTERVAL_MS = 1500
const MAX_RETRIES = 3
const ERROR_PREFIX = 'ERROR:'
const RATE_LIMIT_HINT = /频繁|rate\s*limit|too\s*many/i
/** Default company API host, used when `baseUrl` is left empty. */
const DEFAULT_BASE_URL = 'https://xbsms.work'

/** Next timestamp at which a request may be sent (shared rate limiter). */
let nextAllowedAt = 0

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Serialize calls so the company API rate limit is never exceeded. */
async function throttle(minIntervalMs: number): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, nextAllowedAt - now)
  nextAllowedAt = Math.max(now, nextAllowedAt) + minIntervalMs
  if (wait > 0) await delay(wait)
}

interface EndpointRequest {
  url: string
  headers: Record<string, string>
  params: Record<string, string>
}

function buildRequest(
  config: RegistrationApiConfig,
  endpoint: string,
  params: Record<string, string>,
): EndpointRequest {
  const base = (config.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const headers: Record<string, string> = {}
  const query: Record<string, string> = { ...params }

  if (config.token) {
    if (config.authMode === 'header') {
      headers.Authorization = `Bearer ${config.token}`
    } else {
      query.token = config.token
    }
  }

  return { url: `${base}/api/external/${endpoint}`, headers, params: query }
}

/**
 * Normalize a plain-text response. The API sometimes returns a JSON-encoded
 * string (e.g. `"18209880164"` or `"ok"`), so unwrap a surrounding pair of
 * quotes before use.
 */
export function normalizeBody(text: string): string {
  const trimmed = (text ?? '').trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed === 'string') return parsed.trim()
    } catch {
      // Not valid JSON; fall through to the raw text.
    }
  }
  return trimmed
}

/**
 * Perform one rate-limited call and return the trimmed plain-text body.
 *
 * Throws on transport failures, non-2xx status codes, and `ERROR:` bodies.
 */
async function requestText(
  config: RegistrationApiConfig,
  endpoint: string,
  params: Record<string, string>,
): Promise<string> {
  const minInterval = Math.max(500, config.minRequestIntervalMs || DEFAULT_MIN_INTERVAL_MS)
  const request = buildRequest(config, endpoint, params)
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle(minInterval)

    let status = 0
    let body = ''
    let retryAfterHeader: string | undefined
    try {
      const response = await axios.get(request.url, {
        headers: request.headers,
        params: request.params,
        timeout: REQUEST_TIMEOUT_MS,
        responseType: 'text',
        transformResponse: [(data) => data],
        validateStatus: () => true,
      })
      status = response.status
      retryAfterHeader = response.headers?.['retry-after'] as string | undefined
      body = normalizeBody(
        typeof response.data === 'string' ? response.data : String(response.data ?? ''),
      )
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      await delay(minInterval)
      continue
    }

    if (status === 429 || RATE_LIMIT_HINT.test(body)) {
      lastError = new Error('Registration API rate limited')
      const retryAfter = Number(retryAfterHeader)
      await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : minInterval)
      continue
    }

    if (status < 200 || status >= 300) {
      lastError = new Error(`Registration API ${endpoint} failed: HTTP ${status}`)
      continue
    }

    if (body.startsWith(ERROR_PREFIX)) {
      const message = body.slice(ERROR_PREFIX.length).trim() || `Registration API ${endpoint} error`
      throw new Error(message)
    }

    return body
  }

  throw lastError ?? new Error(`Registration API ${endpoint} failed`)
}

export function normalizePhone(text: string): string {
  return text
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/[\s-]/g, '')
}

function looksLikePhone(text: string): boolean {
  return /^\+?\d{6,15}$/.test(text)
}

/** Extract a 4-8 digit verification code from a plain-text response. */
export function extractVerificationCode(text: string): string | null {
  const trimmed = (text || '').trim()
  if (!trimmed) return null

  if (/^\d{4,8}$/.test(trimmed)) return trimmed

  const labeled = trimmed.match(
    /(?:验证码|校验码|动态码|verification\s*code|\bcode\b)\D{0,6}(\d{4,8})/i,
  )
  if (labeled) return labeled[1]

  const groups = trimmed.match(/\d{4,8}/g)
  return groups && groups.length > 0 ? groups[groups.length - 1] : null
}

/** Whether the number API has enough configuration to be called. */
export function isRegistrationApiReady(config: RegistrationApiConfig | undefined): boolean {
  return !!config?.enabled && !!config.token?.trim()
}

/**
 * Lease the next phone number. The number is returned to the caller only and is
 * never sent to the renderer.
 */
export async function fetchRegistrationPhone(config: RegistrationApiConfig): Promise<string> {
  if (!isRegistrationApiReady(config)) {
    throw new Error('Registration number API is not configured')
  }

  const params: Record<string, string> = { keyWord: config.keyWord || '' }
  if (config.province?.trim()) params.province = config.province.trim()
  if (config.cardType?.trim()) params.cardType = config.cardType.trim()

  const body = await requestText(config, 'getPhone', params)
  const phone = normalizePhone(body)

  if (!looksLikePhone(phone)) {
    throw new Error(`Registration API returned no phone number: ${body.slice(0, 80)}`)
  }

  return phone
}

/**
 * Poll `getCode` (or `getMsg`) until a verification code is returned or the
 * timeout elapses. Business errors while waiting (e.g. no session yet) are
 * ignored so polling continues. Returns `null` when no code arrived.
 */
export async function pollRegistrationCode(
  config: RegistrationApiConfig,
  phone: string,
): Promise<string | null> {
  const endpoint = config.codeSource === 'getMsg' ? 'getMsg' : 'getCode'
  const interval = Math.max(1000, config.codePollIntervalMs || DEFAULT_MIN_INTERVAL_MS)
  const deadline = Date.now() + (config.codePollTimeoutMs || 180000)

  while (Date.now() < deadline) {
    try {
      const body = await requestText(config, endpoint, {
        phone,
        keyWord: config.keyWord || '',
      })
      const code = extractVerificationCode(body)
      if (code) return code
    } catch (error) {
      console.error('[RegistrationApi] Code poll failed:', error)
    }

    await delay(interval)
  }

  return null
}

/** Release a leased number back to the pool. */
export async function releaseRegistrationPhone(
  config: RegistrationApiConfig,
  phone: string,
): Promise<void> {
  if (!config.autoRelease) return
  try {
    await requestText(config, 'release', { phone })
  } catch (error) {
    console.error('[RegistrationApi] Failed to release number:', error)
  }
}

/** Mask a phone number for display: keeps the first 3 and last 4 digits. */
export function maskPhone(phone: string): string {
  const value = (phone || '').trim()
  if (value.length <= 7) return '*'.repeat(Math.max(value.length, 0))
  return `${value.slice(0, 3)}****${value.slice(-4)}`
}

/** Generate a strong random password for a newly registered account. */
export function generateRegistrationPassword(length = 16): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnpqrstuvwxyz'
  const digits = '23456789'
  const symbols = '!@#$%^&*'
  const all = upper + lower + digits + symbols

  const pick = (set: string): string => set[randomInt(set.length)]

  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)]
  while (chars.length < length) chars.push(pick(all))

  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }

  return chars.join('')
}
