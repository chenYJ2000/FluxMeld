/**
 * Disposable-email client for assisted account registration.
 *
 * The backend is pluggable via `config.service`:
 *
 * - tigrmail (default) — https://api.tigrmail.com/v1
 *     POST /v1/inboxes                 -> { inbox }
 *     GET  /v1/messages?inbox=<addr>   -> long-poll, { message: { to, from, subject, body } }
 *     GET  /v1/domains                 -> { domains: string[] }
 *     Auth: `Authorization: Bearer <token>`
 *
 * - yyds (215.im) — https://maliapi.215.im/v1
 *     POST /v1/accounts                -> { data: { address, id, token } }
 *     GET  /v1/messages/next?address=  -> long-poll, { data: { message } } (+ verificationCode)
 *     GET  /v1/domains                 -> { data: [{ domain }] }
 *     Auth: `X-API-Key: AC-...`
 *
 * The inbox is created in the main process and the address is passed to the
 * registration window; the credential itself never leaves the main process.
 *
 * Inboxes are allocated one per registration (each account needs a unique
 * address), so the provider's quota applies.
 */

import axios from 'axios'
import { randomInt } from 'crypto'
import type { EmailApiConfig } from '../../shared/types'

const REQUEST_TIMEOUT_MS = 20000
const DEFAULT_POLL_TIMEOUT_MS = 180000
const DEFAULT_BASE_URLS: Record<EmailApiConfig['service'], string> = {
  tigrmail: 'https://api.tigrmail.com',
  yyds: 'https://maliapi.215.im',
}

/** Minimal inbox shape returned by any backend. */
export interface EmailInbox {
  address: string
  /** Backend-specific id, when provided. */
  id?: string
  /** Per-inbox token, when provided (215.im). */
  token?: string
}

/** A received message, flattened for code extraction. */
export interface EmailMessage {
  to: string[]
  from: string
  subject: string
  body: string
  /** Concatenation of subject + body, convenient for regex matching. */
  text: string
  /** Server-extracted verification code, when the backend provides one. */
  verificationCode?: string
}

function serviceOf(config: EmailApiConfig): EmailApiConfig['service'] {
  return config.service === 'yyds' ? 'yyds' : 'tigrmail'
}

function baseUrl(config: EmailApiConfig): string {
  return (config.baseUrl?.trim() || DEFAULT_BASE_URLS[serviceOf(config)]).replace(/\/+$/, '')
}

function authHeaders(config: EmailApiConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (serviceOf(config) === 'yyds') {
    headers['X-API-Key'] = config.token
  } else {
    headers.Authorization = `Bearer ${config.token}`
  }
  return headers
}

/** Whether the email API is configured enough to attempt a registration. */
export function isEmailApiReady(config: EmailApiConfig | undefined): boolean {
  return !!config?.enabled && !!config?.token?.trim()
}

function extractErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { error?: string; message?: string } | string | undefined
    if (typeof data === 'string' && data.trim()) return data.trim()
    if (data && typeof data === 'object') {
      if (data.error) return data.error
      if (data.message) return data.message
    }
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** List every domain the email provider currently offers. */
export async function listDomains(config: EmailApiConfig): Promise<string[]> {
  if (!isEmailApiReady(config)) throw new Error('Email API is not configured')

  const response = await axios.get(`${baseUrl(config)}/v1/domains`, {
    headers: authHeaders(config),
    timeout: REQUEST_TIMEOUT_MS,
  })
  const data = response.data

  if (serviceOf(config) === 'yyds') {
    const list = data?.data
    if (!Array.isArray(list)) return []
    return list
      .map((entry: unknown) =>
        typeof entry === 'string' ? entry : (entry as { domain?: string })?.domain,
      )
      .filter((d): d is string => typeof d === 'string' && d.includes('.'))
  }

  const domains = data?.domains
  if (!Array.isArray(domains)) return []
  return domains.filter((d): d is string => typeof d === 'string' && d.includes('.'))
}

/** Cached domain list so a batch does not re-fetch it for every inbox. */
let cachedDomains: { base: string; token: string; domains: string[]; at: number } | null = null
const DOMAIN_CACHE_MS = 5 * 60 * 1000

/** Resolve the domains to use, preferring a configured one but otherwise
 *  discovering every available domain and caching the result briefly. */
async function resolveDomains(config: EmailApiConfig): Promise<string[]> {
  const configured = config.domain
    ? config.domain
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean)
    : []
  if (configured.length) return configured

  const base = baseUrl(config)
  if (
    cachedDomains &&
    cachedDomains.base === base &&
    cachedDomains.token === config.token &&
    Date.now() - cachedDomains.at < DOMAIN_CACHE_MS
  ) {
    return cachedDomains.domains
  }

  const domains = await listDomains(config)
  if (domains.length) {
    cachedDomains = { base, token: config.token, domains, at: Date.now() }
  }
  return domains.length ? domains : ['']
}

/** Pick one random domain from the available list. */
function pickDomain(domains: string[]): string {
  if (domains.length <= 1) return domains[0] || ''
  return domains[randomInt(domains.length)]
}

/**
 * Create a fresh inbox. When no domain is configured, every available domain is
 * fetched once (cached) and one is chosen at random, so successive registrations
 * are spread across domains instead of always using the same one.
 */
export async function createInbox(config: EmailApiConfig): Promise<EmailInbox> {
  if (!isEmailApiReady(config)) throw new Error('Email API is not configured')

  const domains = await resolveDomains(config)
  const domain = pickDomain(domains)
  const service = serviceOf(config)

  try {
    if (service === 'yyds') {
      // 215.im: POST /v1/accounts -> { data: { address, id, token } }
      const body: Record<string, string> = {}
      if (domain) body.domain = domain
      const allocate = (allocation: Record<string, string>) =>
        axios.post(`${baseUrl(config)}/v1/accounts`, allocation, {
          headers: authHeaders(config),
          timeout: REQUEST_TIMEOUT_MS,
        })
      const response = await allocate(body).catch((error: unknown) => {
        // The public domain list can include domains closed to new addresses.
        // With automatic selection, let the service allocate an eligible domain.
        // Explicit domains and other failures must remain visible to the user.
        if (
          !config.domain?.trim() &&
          domain &&
          axios.isAxiosError(error) &&
          /shared domain is currently restricted and not accepting new public addresses/i.test(
            extractErrorMessage(error),
          )
        ) {
          console.warn('Email API rejected an automatically selected domain; requesting allocation')
          return allocate({})
        }
        throw error
      })
      const data = response.data?.data
      const address = data?.address
      if (typeof address !== 'string' || !address.includes('@')) {
        throw new Error(
          `Email API returned no inbox: ${JSON.stringify(response.data).slice(0, 120)}`,
        )
      }
      return { address, id: data?.id, token: data?.token }
    }

    // tigrmail: POST /v1/inboxes -> { inbox }
    const body: Record<string, string> = {}
    if (domain) body.domain = domain
    const response = await axios.post(`${baseUrl(config)}/v1/inboxes`, body, {
      headers: authHeaders(config),
      timeout: REQUEST_TIMEOUT_MS,
    })
    const address = response.data?.inbox
    if (typeof address !== 'string' || !address.includes('@')) {
      throw new Error(`Email API returned no inbox: ${JSON.stringify(response.data).slice(0, 120)}`)
    }
    return { address }
  } catch (error) {
    throw new Error(`Failed to create inbox: ${extractErrorMessage(error)}`)
  }
}

/**
 * Long-poll for the next message delivered to `inbox`. Resolves with the
 * message or `null` once `timeoutMs` elapses. `signal` aborts the wait.
 */
export async function waitForMessage(
  config: EmailApiConfig,
  inbox: string,
  options: { timeoutMs?: number; signal?: AbortSignal; subjectContains?: string } = {},
): Promise<EmailMessage | null> {
  const timeoutMs = options.timeoutMs ?? config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const service = serviceOf(config)

  if (service === 'yyds') {
    return waitYyds(config, inbox, timeoutMs, options.signal)
  }
  return waitTigrmail(config, inbox, timeoutMs, options.signal, options.subjectContains)
}

/** tigrmail long-poll: GET /v1/messages?inbox=. */
async function waitTigrmail(
  config: EmailApiConfig,
  inbox: string,
  timeoutMs: number,
  signal?: AbortSignal,
  subjectContains?: string,
): Promise<EmailMessage | null> {
  const deadline = Date.now() + timeoutMs
  const params: Record<string, string> = { inbox }
  if (subjectContains) params.subjectContains = subjectContains

  while (Date.now() < deadline) {
    if (signal?.aborted) return null
    const remaining = deadline - Date.now()
    try {
      const response = await axios.get(`${baseUrl(config)}/v1/messages`, {
        headers: authHeaders(config),
        params,
        timeout: remaining,
        signal,
      })
      const message = response.data?.message
      if (message && typeof message === 'object') return normalizeMessage(message)
    } catch (error) {
      if (signal?.aborted) return null
      if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') return null
    }
  }
  return null
}

/** 215.im long-poll: GET /v1/messages/next?address=&wait=<0-30>. 204 = none. */
async function waitYyds(
  config: EmailApiConfig,
  inbox: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<EmailMessage | null> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (signal?.aborted) return null
    const remaining = Math.min(30000, deadline - Date.now())
    try {
      const response = await axios.get(`${baseUrl(config)}/v1/messages/next`, {
        headers: authHeaders(config),
        params: { address: inbox, wait: Math.max(0, Math.floor(remaining / 1000)) },
        timeout: remaining + 5000,
        signal,
        validateStatus: (status) => status === 200 || status === 204,
      })
      if (response.status === 204) continue
      const message = response.data?.data?.message
      if (message && typeof message === 'object') return normalizeMessage(message)
    } catch (error) {
      if (signal?.aborted) return null
      if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') return null
    }
  }
  return null
}

function normalizeMessage(raw: Record<string, unknown>): EmailMessage {
  const to = Array.isArray(raw.to)
    ? (raw.to as unknown[]).map((t) =>
        typeof t === 'string' ? t : ((t as { address?: string })?.address ?? ''),
      )
    : raw.to
      ? [String(raw.to)]
      : []
  const fromRaw = raw.from
  const from =
    typeof fromRaw === 'string' ? fromRaw : ((fromRaw as { address?: string })?.address ?? '')
  const subject = typeof raw.subject === 'string' ? raw.subject : ''
  // Backends differ: tigrmail uses `body`, 215.im uses `text` (plus `html`).
  let body = typeof raw.body === 'string' ? raw.body : ''
  if (!body && typeof raw.text === 'string') body = raw.text
  if (!body && Array.isArray(raw.html) && typeof raw.html[0] === 'string') {
    body = raw.html[0] as string
  }
  const verificationCode =
    typeof raw.verificationCode === 'string' ? raw.verificationCode : undefined
  return { to, from, subject, body, text: `${subject}\n${body}`, verificationCode }
}

/**
 * Reduce a message body to human-readable text so codes can be matched without
 * picking up CSS values (`#000000`, `padding: 100px`, …) from HTML emails.
 */
export function toReadableText(input: string): string {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract a numeric verification code from an email. Prefers the backend's own
 * `verificationCode`, then a code near a "code"/"verification" keyword, then a
 * standalone 4-8 digit run. HTML/CSS is stripped first so style values are
 * never mistaken for the code.
 */
export function extractEmailCode(message: EmailMessage | null): string | null {
  if (!message) return null
  if (message.verificationCode?.trim()) return message.verificationCode.trim()

  const text = toReadableText(message.text)

  const keywordMatch = text.match(
    /(?:code|verification|verify|otp|验证码|校验码)[^\d]{0,12}(\d{4,8})/i,
  )
  if (keywordMatch) return keywordMatch[1]

  const generic = text.match(/(?<!\d)(\d{4,8})(?!\d)/)
  return generic ? generic[1] : null
}
