/**
 * NetFountain gateway client.
 *
 * Talks to the proxy-layer gateway (see USAGE.md): `{baseUrl}/{site}/...`.
 * Uses a dedicated axios instance so the per-request egress interceptor (which
 * is installed on the default axios export) never proxies pool management calls
 * back through an exit.
 *
 * Every method resolves with a value instead of throwing: transport failures
 * must not crash the activation loop.
 */

import axios, { type AxiosRequestConfig } from 'axios'

const DEFAULT_TIMEOUT_MS = 8000

/** One record returned by the gateway (`data` of an acquire/count response). */
export interface NetFountainRecord {
  id: number
  ip: string
  port: number
  protocol: string
  proxy_url: string
  latency_ms: number | null
  leased: boolean
  /** Remaining lifetime in seconds; `null` = provider does not expire it. */
  ttl: number | null
  created_at: number | null
}

export interface NetFountainCount {
  total: number
  free_total: number
  [key: string]: unknown
}

export type NetFountainAcquireResult =
  | { status: 'ok'; record: NetFountainRecord }
  | { status: 'empty'; error: string }
  | { status: 'config-error'; error: string }
  | { status: 'error'; error: string }

export interface NetFountainResponse {
  status: number
  data: unknown
}

export type HttpMethod = 'GET' | 'POST' | 'DELETE'

/** Injectable transport so the client can be exercised without real HTTP. */
export type NetFountainHttpFn = (request: {
  method: HttpMethod
  url: string
  timeoutMs: number
}) => Promise<NetFountainResponse>

export interface NetFountainClientOptions {
  baseUrl: string
  site: string
  timeoutMs?: number
  http?: NetFountainHttpFn
}

interface Envelope {
  code: number
  msg: string
  data: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseEnvelope(raw: unknown): Envelope | null {
  const record = asRecord(raw)
  if (!record) return null
  const code = toFiniteNumber(record.code)
  if (code === null) return null
  return {
    code,
    msg: typeof record.msg === 'string' ? record.msg : '',
    data: record.data ?? null,
  }
}

/** Normalize one gateway record; returns null for malformed entries. */
export function parseNetFountainRecord(raw: unknown): NetFountainRecord | null {
  const record = asRecord(raw)
  if (!record) return null

  const id = toFiniteNumber(record.id)
  const port = toFiniteNumber(record.port)
  const ip = typeof record.ip === 'string' ? record.ip.trim() : ''
  if (
    id === null ||
    !Number.isInteger(id) ||
    id < 0 ||
    port === null ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !ip
  ) {
    return null
  }

  const protocol = typeof record.protocol === 'string' ? record.protocol.trim().toLowerCase() : ''
  const proxyUrl = typeof record.proxy_url === 'string' ? record.proxy_url.trim() : ''

  return {
    id,
    ip,
    port,
    protocol,
    proxy_url: proxyUrl || `${protocol || 'http'}://${ip}:${port}`,
    latency_ms: toFiniteNumber(record.latency_ms),
    leased: record.leased === true,
    ttl: toFiniteNumber(record.ttl),
    created_at: toFiniteNumber(record.created_at),
  }
}

const netFountainAxios = axios.create()

async function defaultHttp(request: {
  method: HttpMethod
  url: string
  timeoutMs: number
}): Promise<NetFountainResponse> {
  const config: AxiosRequestConfig = {
    method: request.method,
    url: request.url,
    timeout: request.timeoutMs,
    validateStatus: () => true,
  }
  const response = await netFountainAxios.request(config)
  return { status: response.status, data: response.data }
}

export class NetFountainClient {
  private readonly baseUrl: string
  private readonly site: string
  private readonly timeoutMs: number
  private readonly http: NetFountainHttpFn

  constructor(options: NetFountainClientOptions) {
    this.baseUrl = String(options.baseUrl ?? '').replace(/\/+$/, '')
    this.site = String(options.site ?? '').replace(/^\/+|\/+$/g, '')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.http = options.http ?? defaultHttp
  }

  private url(path: string): string {
    return `${this.baseUrl}/${encodeURIComponent(this.site)}${path}`
  }

  private async send(method: HttpMethod, url: string): Promise<Envelope | null> {
    try {
      const response = await this.http({ method, url, timeoutMs: this.timeoutMs })
      return parseEnvelope(response.data)
    } catch {
      return null
    }
  }

  private async succeeded(method: HttpMethod, url: string): Promise<boolean> {
    const envelope = await this.send(method, url)
    return envelope?.code === 0
  }

  /** `GET /{site}/count`; null when unreachable or malformed. */
  async count(): Promise<NetFountainCount | null> {
    const envelope = await this.send('GET', this.url('/count'))
    const data = asRecord(envelope?.data)
    if (!envelope || envelope.code !== 0 || !data) return null
    return data as NetFountainCount
  }

  /**
   * `POST /{site}/ips/acquire` with `strategy=remaining_desc` (longest
   * remaining first) and a `min_remaining_sec` floor.
   */
  async acquire(minRemainingSeconds: number): Promise<NetFountainAcquireResult> {
    const min = Number.isFinite(minRemainingSeconds) ? Math.max(0, minRemainingSeconds) : 0
    const path = `/ips/acquire?strategy=remaining_desc&min_remaining_sec=${min}`
    const envelope = await this.send('POST', this.url(path))
    if (!envelope) {
      return { status: 'error', error: 'NetFountain gateway returned an invalid response.' }
    }
    if (envelope.code === 40402) return { status: 'empty', error: envelope.msg }
    if (envelope.code === 40000 || envelope.code === 40400) {
      return { status: 'config-error', error: envelope.msg || `NetFountain error ${envelope.code}` }
    }
    if (envelope.code !== 0) {
      return { status: 'error', error: envelope.msg || `NetFountain error ${envelope.code}` }
    }

    const record = parseNetFountainRecord(envelope.data)
    if (!record) return { status: 'error', error: 'NetFountain returned a malformed record.' }
    return { status: 'ok', record }
  }

  /** `DELETE /{site}/ips/{id}` — permanently remove a leased record. */
  async remove(id: number): Promise<boolean> {
    return this.succeeded('DELETE', this.url(`/ips/${id}`))
  }

  /** `POST /{site}/ips/{id}/release` — return a record to the free pool. */
  async release(id: number): Promise<boolean> {
    return this.succeeded('POST', this.url(`/ips/${id}/release`))
  }
}
