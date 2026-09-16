/**
 * NetFountain egress source.
 *
 * Leases exits one at a time from the proxy-layer gateway (see USAGE.md) and
 * exposes them as `EgressExit`s. Acquisition rules:
 *   - longest remaining lifetime first (`strategy=remaining_desc`);
 *   - only records with remaining time above `minRemainingSeconds`;
 *   - unsupported protocols (e.g. `socks4`) are deleted and re-acquired;
 *   - an empty pool is retried every `emptyPoolWaitMs` until the acquisition
 *     is aborted (proxy disabled / active source changed).
 *
 * Because exits are leased, the source implements the optional `acquireExit` /
 * `disposeExit` lifecycle: the manager acquires on demand and deletes an old IP
 * before switching to a new one. `deactivate()` releases every held lease.
 */

import { NETFOUNTAIN_META } from './config.ts'
import { NetFountainClient, type NetFountainRecord } from './client.ts'
import type {
  EgressExit,
  EgressProbeResult,
  EgressProtocol,
  EgressServices,
  EgressSource,
  EgressSourceModuleMeta,
} from '../types.ts'

const DEFAULT_BASE_URL = 'http://127.0.0.1:9000/api/v1'
const DEFAULT_SITE = 'glm'
const DEFAULT_MIN_REMAINING_SECONDS = 120
const DEFAULT_EMPTY_POOL_WAIT_MS = 20000
const REQUEST_TIMEOUT_MS = 8000

/** Gateway protocols this app can actually route through. */
const SUPPORTED_PROTOCOLS: Record<string, EgressProtocol | undefined> = {
  http: 'http',
  https: 'https',
  socks5: 'socks5',
  socks5h: 'socks5h',
}

interface NetFountainSettings {
  baseUrl: string
  site: string
  minRemainingSeconds: number
  emptyPoolWaitMs: number
}

export interface NetFountainSourceDeps {
  /** Test seam: reuse a preconfigured client instead of building one. */
  client?: NetFountainClient
}

function toNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}

function recordToExit(record: NetFountainRecord, protocol: EgressProtocol): EgressExit {
  const expiresAt =
    record.ttl !== null && record.created_at !== null
      ? (record.created_at + record.ttl) * 1000
      : undefined
  return {
    id: String(record.id),
    name: `${record.ip}:${record.port}`,
    protocol,
    host: record.ip,
    port: record.port,
    expiresAt,
  }
}

/** Resolves `false` when the abort signal fires before the delay elapses. */
function delay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (ms <= 0) return Promise.resolve(true)

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort)
  })
}

export class NetFountainSource implements EgressSource {
  readonly meta: EgressSourceModuleMeta = NETFOUNTAIN_META

  /** Exits currently leased from the gateway, keyed by exit id. */
  private readonly held = new Map<string, EgressExit>()
  private client: NetFountainClient | null = null
  private clientSignature = ''

  constructor(
    private readonly services: EgressServices,
    private readonly deps: NetFountainSourceDeps = {},
  ) {}

  private getSettings(): NetFountainSettings {
    const raw = this.services.getSettings()
    return {
      baseUrl: String(raw.baseUrl ?? '').trim() || DEFAULT_BASE_URL,
      site: String(raw.site ?? '').trim() || DEFAULT_SITE,
      minRemainingSeconds: toNonNegativeNumber(
        raw.minRemainingSeconds,
        DEFAULT_MIN_REMAINING_SECONDS,
      ),
      emptyPoolWaitMs: toNonNegativeNumber(raw.emptyPoolWaitMs, DEFAULT_EMPTY_POOL_WAIT_MS),
    }
  }

  private getClient(settings: NetFountainSettings): NetFountainClient {
    if (this.deps.client) return this.deps.client
    const signature = `${settings.baseUrl}|${settings.site}`
    if (this.client && this.clientSignature === signature) return this.client
    this.client = new NetFountainClient({
      baseUrl: settings.baseUrl,
      site: settings.site,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
    this.clientSignature = signature
    return this.client
  }

  async probe(): Promise<EgressProbeResult> {
    const settings = this.getSettings()
    const count = await this.getClient(settings).count()
    if (!count) {
      return {
        available: false,
        error: `NetFountain gateway unreachable: ${settings.baseUrl}/${settings.site}`,
        details: { baseUrl: settings.baseUrl, site: settings.site },
      }
    }
    // Available even when `free_total` is 0: acquisition waits for a free IP.
    return {
      available: true,
      details: {
        baseUrl: settings.baseUrl,
        site: settings.site,
        freeTotal: count.free_total,
        total: count.total,
      },
    }
  }

  async listExits(): Promise<EgressExit[]> {
    return [...this.held.values()]
  }

  async acquireExit(signal?: AbortSignal): Promise<EgressExit | null> {
    const settings = this.getSettings()
    const client = this.getClient(settings)

    while (!signal?.aborted) {
      const outcome = await client.acquire(settings.minRemainingSeconds)
      if (signal?.aborted) return null

      if (outcome.status === 'ok') {
        const protocol = SUPPORTED_PROTOCOLS[outcome.record.protocol]
        if (!protocol) {
          this.services.logger.warn(
            `[Egress] NetFountain returned unsupported protocol "${outcome.record.protocol}"; deleting and re-acquiring`,
          )
          await client.remove(outcome.record.id)
          continue
        }
        const exit = recordToExit(outcome.record, protocol)
        this.held.set(exit.id, exit)
        return exit
      }

      if (outcome.status === 'config-error') {
        this.services.logger.warn(`[Egress] NetFountain configuration error: ${outcome.error}`)
        return null
      }

      this.services.logger.info(
        `[Egress] NetFountain (${settings.site}) has no usable IP; retrying in ${settings.emptyPoolWaitMs}ms`,
      )
      const waited = await delay(settings.emptyPoolWaitMs, signal)
      if (!waited) return null
    }

    return null
  }

  async apply(): Promise<boolean> {
    // Leased IPs are directly usable; no source-side switching needed.
    return true
  }

  async disposeExit(exit: EgressExit): Promise<void> {
    this.held.delete(exit.id)
    const id = Number(exit.id)
    if (!Number.isInteger(id)) return
    const settings = this.getSettings()
    await this.getClient(settings).remove(id)
  }

  async deactivate(): Promise<void> {
    const settings = this.getSettings()
    const client = this.getClient(settings)
    const ids = [...this.held.values()]
      .map((exit) => Number(exit.id))
      .filter((id) => Number.isInteger(id))
    this.held.clear()
    // Return leases to the pool one by one instead of release-all, so leases
    // held by other consumers of the same site are left untouched.
    for (const id of ids) {
      await client.release(id)
    }
  }
}
