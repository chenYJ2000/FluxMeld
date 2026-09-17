/**
 * EgressManager
 *
 * The single orchestrator for outbound proxying. It:
 *   - owns the configured egress sources (from `outboundProxy` config),
 *   - allocates exits through the shared `ExitAllocator`,
 *   - applies the effective exit to each upstream request via a request-scoped
 *     async-local context (`runWithEgress`), never mutating global axios state,
 *   - implements the single-exit mode and per-account group routing.
 *
 * Resilience: activation and per-group allocation are single-flight (concurrent
 * callers share one attempt), exits are applied *before* being verified (so dead
 * nodes are actually skipped), and failures back off with a cooldown. A
 * generation token invalidates in-flight work when the source or mode changes.
 *
 * Dependencies on the store are injected through `setDeps()` (wired in
 * `egress/index.ts`) to keep this module free of store import cycles.
 */

import { ExitAllocator } from './allocation.ts'
import { RotationScheduler } from './common/rotation/index.ts'
import { verifyExit as defaultVerifyExit } from './common/verification.ts'
import { createEgressSource, getEgressSourceMetas } from './registry.ts'
import type {
  EgressExit,
  EgressProbeResult,
  EgressSource,
  EgressSourceConfig,
  EgressSourceModuleMeta,
  EgressLogger,
  RotationPolicy,
} from './types.ts'
import type { ProxyGroup } from '../../shared/types'

/** Sentinel group id for accounts that must stay strictly direct. */
export const DIRECT_GROUP = '__direct__'

/** When true, an enabled single-exit proxy that cannot activate fails the
 * request fast instead of silently falling back to a direct connection. */
export const EGRESS_FAIL_FAST = true

/** Defaults for the configurable rotation policy values. */
const VERIFY_TIMEOUT_MS = 2000
const COOLDOWN_BASE_MS = 1000
const COOLDOWN_MAX_MS = 30000
const MIN_ROTATE_INTERVAL_MS = 3000

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(Math.max(num, min), max)
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(clampNumber(value, fallback, min, max))
}

/** Thrown when the proxy is enabled but no exit could be activated. */
export class EgressUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EgressUnavailableError'
  }
}

export type ProxyCountScope = 'global' | 'provider'

export interface EgressStatus {
  enabled: boolean
  sourceId: string | null
  proxyUrl: string
  exitId: string | null
  node: string | null
  expiresAt: number | null
}

export interface EgressCheckResult {
  available: boolean
  error?: string
  details?: Record<string, unknown>
}

export interface OutboundProxySettings {
  enabled: boolean
  groupAssignmentEnabled: boolean
  activeSourceId: string
  rotation: RotationPolicy
  sources: EgressSourceConfig[]
  groups: ProxyGroup[]
}

export interface EgressManagerDeps {
  getSettings(): OutboundProxySettings
  getProviderAssignment(providerId: string): Record<string, string | null> | undefined
  getAccountIds(providerId: string): string[]
  listProviderIds(): string[]
  getProviderName(providerId: string): string
  logger: EgressLogger
}

export interface AssignmentOverview {
  groups: ProxyGroup[]
  groupAssignmentEnabled: boolean
  assignment: Record<string, string | null>
  providerTotals: { total: number; byGroup: Record<string, number> }
  globalTotals: { total: number; byGroup: Record<string, number> }
  groupExits: Record<string, EgressExit | null>
}

export interface AutoAssignResult {
  assignment: Record<string, string | null>
  groups: ProxyGroup[]
}

const DEFAULT_ROTATION: RotationPolicy = {
  strategy: 'roundRobin',
  rotateEarlySeconds: 30,
  verifyBeforeUse: true,
  verifyTimeoutMs: VERIFY_TIMEOUT_MS,
  maxExitAttempts: 0,
  rotateAfterFailures: 2,
  rotateMinIntervalMs: MIN_ROTATE_INTERVAL_MS,
  cooldownBaseMs: COOLDOWN_BASE_MS,
  cooldownMaxMs: COOLDOWN_MAX_MS,
}

const DEFAULT_SETTINGS: OutboundProxySettings = {
  enabled: false,
  groupAssignmentEnabled: false,
  activeSourceId: '',
  rotation: DEFAULT_ROTATION,
  sources: [],
  groups: [],
}

export class EgressManager {
  private proxyMode = false
  private globalExit: EgressExit | null = null
  private activeSource: EgressSource | null = null
  private activeSourceConfigId: string | null = null
  private readonly allocator = new ExitAllocator()
  private pool: EgressExit[] = []
  /** Runtime groupId -> currently assigned exit (never persisted). */
  private readonly groupExits = new Map<string, EgressExit>()
  private readonly scheduler = new RotationScheduler()
  private deps: EgressManagerDeps | null = null

  /** Invalidates in-flight async work when the source/mode changes. */
  private generation = 0
  private activationPromise: Promise<boolean> | null = null
  private rotationPromise: Promise<string | null> | null = null
  private readonly groupEnsurePromises = new Map<string, Promise<EgressExit | null>>()
  private readonly groupRotatePromises = new Map<string, Promise<string | null>>()
  /** Aborts blocking `acquireExit()` calls when the source/mode changes. */
  private abortController: AbortController | null = null
  /** Identity of the currently-cached source (id|sourceId|settings). */
  private activeSourceSignature: string | null = null
  /** Consecutive proxy-failure counts that defer rotation (global / per group). */
  private globalFailureCount = 0
  private readonly groupFailureCounts = new Map<string, number>()
  private consecutiveFailures = 0
  private cooldownUntil = 0
  private lastRotateAt = 0
  private readonly lastGroupRotateAt = new Map<string, number>()

  setDeps(deps: EgressManagerDeps): void {
    this.deps = deps
  }

  /**
   * Drop all runtime state so the next call rebuilds from config. Aborts any
   * blocking acquisition; when the resolved active source actually changed its
   * leases are released (rotation/assignment-only edits leave it untouched).
   */
  invalidateSource(): void {
    const config = this.resolveActiveSourceConfig(this.getSettings())
    const nextSignature = config ? this.sourceSignature(config) : null
    const previous = this.activeSource
    const changed = previous !== null && this.activeSourceSignature !== nextSignature
    this.resetRuntime()
    if (changed && previous) this.disposeSource(previous)
  }

  /** Clear the failure cooldown (manual enable, config save, successful check). */
  resetCooldown(): void {
    this.consecutiveFailures = 0
    this.cooldownUntil = 0
  }

  /** Forget a deleted group's runtime exit binding. */
  forgetGroup(groupId: string): void {
    const exit = this.groupExits.get(groupId)
    if (exit) {
      this.allocator.release(exit.id)
      this.disposeExit(exit)
    }
    this.groupExits.delete(groupId)
    this.groupEnsurePromises.delete(groupId)
    this.groupRotatePromises.delete(groupId)
    this.lastGroupRotateAt.delete(groupId)
    this.groupFailureCounts.delete(groupId)
  }

  private resetRuntime(): void {
    this.abortController?.abort()
    this.abortController = null
    this.generation += 1
    this.activationPromise = null
    this.rotationPromise = null
    this.groupEnsurePromises.clear()
    this.groupRotatePromises.clear()
    this.lastGroupRotateAt.clear()
    this.activeSource = null
    this.activeSourceConfigId = null
    this.activeSourceSignature = null
    this.pool = []
    this.groupExits.clear()
    this.globalExit = null
    this.proxyMode = false
    this.globalFailureCount = 0
    this.groupFailureCounts.clear()
    this.allocator.reset()
  }

  // ---------- configuration ----------

  private getSettings(): OutboundProxySettings {
    if (!this.deps) return { ...DEFAULT_SETTINGS }
    const raw = this.deps.getSettings()
    return {
      ...DEFAULT_SETTINGS,
      ...(raw ?? {}),
      rotation: { ...DEFAULT_ROTATION, ...(raw?.rotation ?? {}) },
      sources: raw?.sources ?? [],
      groups: raw?.groups ?? [],
    }
  }

  isGroupAssignmentEnabled(): boolean {
    return this.getSettings().groupAssignmentEnabled
  }

  private resolveActiveSourceConfig(settings: OutboundProxySettings): EgressSourceConfig | null {
    if (settings.sources.length === 0) return null
    const byId = settings.sources.find((source) => source.id === settings.activeSourceId)
    return byId ?? settings.sources[0]
  }

  private buildServices(settings: OutboundProxySettings) {
    return {
      rotation: settings.rotation,
      logger: {
        info: (message: string) => this.log(message),
        warn: (message: string) => this.log(message),
      },
    }
  }

  private getActiveSource(settings: OutboundProxySettings): EgressSource | null {
    const config = this.resolveActiveSourceConfig(settings)
    if (!config) {
      this.clearActiveSource()
      return null
    }

    const signature = this.sourceSignature(config)
    if (this.activeSource && this.activeSourceSignature === signature) return this.activeSource

    // The resolved source changed: drop the previous one (releasing any leases).
    this.clearActiveSource()
    this.activeSource = createEgressSource(config, this.buildServices(settings))
    this.activeSourceConfigId = config.id
    this.activeSourceSignature = signature
    return this.activeSource
  }

  private sourceSignature(config: EgressSourceConfig): string {
    let settings = ''
    try {
      settings = JSON.stringify(config.settings ?? {})
    } catch {
      settings = ''
    }
    return `${config.id}|${config.sourceId}|${settings}`
  }

  private clearActiveSource(): void {
    const previous = this.activeSource
    this.abortController?.abort()
    this.abortController = null
    this.activeSource = null
    this.activeSourceConfigId = null
    this.activeSourceSignature = null
    this.pool = []
    this.groupExits.clear()
    this.globalFailureCount = 0
    this.groupFailureCounts.clear()
    this.allocator.reset()
    if (previous) this.disposeSource(previous)
  }

  /** Sources that lease exits implement `acquireExit` and are manager-driven. */
  private isAcquireMode(source: EgressSource): boolean {
    return typeof source.acquireExit === 'function'
  }

  /** Release all source-side leases (best-effort, fire-and-forget). */
  private disposeSource(source: EgressSource): void {
    if (!this.isAcquireMode(source)) return
    void source.deactivate().catch(() => {
      // ignore release failures
    })
  }

  /** Dispose a single leased exit the manager no longer uses (best-effort). */
  private disposeExit(exit: EgressExit): void {
    const source = this.activeSource
    if (!source || !this.isAcquireMode(source) || !source.disposeExit) return
    void source.disposeExit(exit).catch(() => {
      // ignore dispose failures
    })
  }

  private getAbortSignal(): AbortSignal | undefined {
    if (!this.abortController) this.abortController = new AbortController()
    return this.abortController.signal
  }

  // ---------- status ----------

  isProxyMode(): boolean {
    return this.proxyMode
  }

  getActiveExit(): EgressExit | null {
    return this.proxyMode ? this.globalExit : null
  }

  getProxyUrl(): string {
    const exit = this.getActiveExit()
    return exit ? `${exit.protocol}://${exit.host}:${exit.port}` : ''
  }

  getEgressNodeName(): string | null {
    const exit = this.getActiveExit()
    return exit ? (exit.name ?? exit.id) : null
  }

  getEgressSourceMetas(): EgressSourceModuleMeta[] {
    return getEgressSourceMetas()
  }

  getStatus(): EgressStatus {
    const settings = this.getSettings()
    return {
      enabled: settings.enabled,
      sourceId: this.activeSourceConfigId,
      proxyUrl: this.getProxyUrl(),
      exitId: this.globalExit?.id ?? null,
      node: this.getEgressNodeName(),
      expiresAt: this.globalExit?.expiresAt ?? null,
    }
  }

  // ---------- discovery / availability ----------

  async checkAvailability(): Promise<EgressCheckResult> {
    const settings = this.getSettings()
    const source = this.getActiveSource(settings)
    if (!source) {
      return { available: false, error: 'No egress source configured.' }
    }
    const result: EgressProbeResult = await source.probe()
    return { available: result.available, error: result.error, details: result.details }
  }

  /**
   * Probe one configured source (by its persisted/draft config) using that
   * source's own `probe()` implementation. The instance is throwaway so it
   * never disturbs the active-source cache.
   */
  async checkSource(config: EgressSourceConfig): Promise<EgressCheckResult> {
    const settings = this.getSettings()
    const source = createEgressSource(config, this.buildServices(settings))
    if (!source) {
      return { available: false, error: `Unknown egress source type: ${config.sourceId}` }
    }
    const result: EgressProbeResult = await source.probe()
    if (result.available) this.resetCooldown()
    return { available: result.available, error: result.error, details: result.details }
  }

  async getExits(): Promise<EgressExit[]> {
    const settings = this.getSettings()
    const source = this.getActiveSource(settings)
    if (!source) return []
    // Leased sources expose their currently-held exits (no acquisition here).
    if (this.isAcquireMode(source)) return source.listExits()
    await this.refreshPool(source)
    // Expose only real, selectable, live exits (skip policy groups / dead nodes).
    return this.pool.filter((exit) => exit.selectable !== false && exit.alive !== false)
  }

  private async refreshPool(source: EgressSource): Promise<void> {
    this.pool = await source.listExits()
  }

  // ---------- activation (single-exit mode) ----------

  private async verify(
    exit: EgressExit,
    source: EgressSource,
    settings: OutboundProxySettings,
  ): Promise<boolean> {
    if (!settings.rotation.verifyBeforeUse) return true
    if (source.verifyExit) return source.verifyExit(exit)
    const timeoutMs = clampNumber(settings.rotation.verifyTimeoutMs, VERIFY_TIMEOUT_MS, 100, 120000)
    return defaultVerifyExit(exit, { timeoutMs })
  }

  /**
   * Resolve the candidate budget for one scan. `maxExitAttempts > 0` is an
   * explicit cap; `0` (auto) falls back to the source default (`'all'` = whole
   * table length, otherwise the source's number, default 10).
   */
  private resolveMaxAttempts(
    settings: OutboundProxySettings,
    source: EgressSource,
    tableLength: number,
  ): number {
    const configured = clampInt(settings.rotation.maxExitAttempts, 0, 0, 100000)
    if (configured > 0) return configured
    const fallback = source.meta.defaultMaxExitAttempts ?? 10
    return fallback === 'all' ? tableLength : Math.max(1, fallback)
  }

  /**
   * Scan the exit table starting at the shared cursor:
   *   - policy groups / DIRECT / REJECT / banners and in-use exits are skipped
   *     and consume one candidate;
   *   - dead exits (`alive === false`) are skipped without consuming a candidate;
   *   - a live exit is applied then verified; success claims it, failure
   *     consumes a candidate.
   * The candidate budget is `maxExitAttempts` (or the source default when 0).
   */
  private async scanTable(
    source: EgressSource,
    settings: OutboundProxySettings,
    gen: number,
  ): Promise<EgressExit | null> {
    const table = this.pool
    const total = table.length
    if (total === 0) return null

    const start = this.allocator.position()
    let remaining = this.resolveMaxAttempts(settings, source, total)
    let inspected = 0

    while (inspected < total && remaining > 0) {
      if (gen !== this.generation) return null

      const index = (start + inspected) % total
      const entry = table[index]
      inspected += 1

      if (entry.selectable === false) {
        remaining -= 1
        continue
      }
      if (entry.alive === false) {
        // Dead node: skipped, no candidate consumed.
        continue
      }
      if (this.allocator.isInUse(entry.id)) {
        remaining -= 1
        continue
      }

      const applied = await source.apply(entry)
      if (gen !== this.generation) return null
      if (applied && (await this.verify(entry, source, settings))) {
        this.allocator.markInUse(entry.id)
        this.allocator.setPosition((index + 1) % total)
        return entry
      }
      this.log(`Exit unusable, skipping: ${entry.name ?? entry.id}`)
      remaining -= 1
    }

    this.allocator.setPosition((start + inspected) % total)
    return null
  }

  /**
   * Lease-mode selection: acquire a fresh exit, apply and verify it; unusable
   * candidates are disposed and replaced, up to the candidate budget. Blocks
   * inside `acquireExit` until an IP is available or acquisition is aborted.
   */
  private async acquireUsableExit(
    source: EgressSource,
    settings: OutboundProxySettings,
    gen: number,
  ): Promise<EgressExit | null> {
    const acquire = source.acquireExit
    if (!acquire) return null

    const budget = this.resolveMaxAttempts(settings, source, 1)
    const signal = this.getAbortSignal()

    for (let attempt = 0; attempt < budget; attempt += 1) {
      if (gen !== this.generation) return null
      const exit = await acquire.call(source, signal)
      if (gen !== this.generation || !exit) return null

      const applied = await source.apply(exit)
      if (gen !== this.generation) return null
      if (applied && (await this.verify(exit, source, settings))) {
        this.allocator.markInUse(exit.id)
        return exit
      }

      this.log(`Exit unusable, discarding: ${exit.name ?? exit.id}`)
      if (source.disposeExit) await source.disposeExit(exit)
    }

    return null
  }

  /** Pick a usable exit (leased sources acquire; table sources scan). */
  private async pickUsableExit(
    source: EgressSource,
    settings: OutboundProxySettings,
    gen: number,
  ): Promise<EgressExit | null> {
    if (this.isAcquireMode(source)) {
      return this.acquireUsableExit(source, settings, gen)
    }

    const previous = this.globalExit
    const exit = await this.scanTable(source, settings, gen)
    if (gen !== this.generation) return null
    if (!exit && previous) {
      try {
        await source.apply(previous)
      } catch {
        // best-effort restore
      }
    }
    return exit
  }

  private noteFailure(): void {
    const { rotation } = this.getSettings()
    const base = clampNumber(rotation.cooldownBaseMs, COOLDOWN_BASE_MS, 0, COOLDOWN_MAX_MS)
    const max = clampNumber(rotation.cooldownMaxMs, COOLDOWN_MAX_MS, 0, 3600000)
    this.consecutiveFailures += 1
    const delay = Math.min(
      base * 2 ** Math.max(0, this.consecutiveFailures - 1),
      Math.max(base, max),
    )
    this.cooldownUntil = Date.now() + delay
  }

  private noteSuccess(): void {
    this.consecutiveFailures = 0
    this.cooldownUntil = 0
  }

  /** Single-flight on-demand activation shared by all concurrent callers. */
  private activate(): Promise<boolean> {
    if (this.proxyMode && this.globalExit) return Promise.resolve(true)
    if (this.activationPromise) return this.activationPromise
    if (Date.now() < this.cooldownUntil) return Promise.resolve(false)

    const gen = this.generation
    const promise = this.enterProxyMode(gen).catch(() => false)
    this.activationPromise = promise
    void promise.finally(() => {
      if (this.activationPromise === promise) this.activationPromise = null
    })
    return promise
  }

  async enable(): Promise<{ success: boolean; error?: string; node?: string | null }> {
    const settings = this.getSettings()
    this.resetCooldown()

    if (settings.groupAssignmentEnabled) {
      const ready = await this.prepareGroupPool(settings)
      if (!ready) return { success: false, error: 'No usable egress exit available.' }
      return { success: true, node: null }
    }

    const entered = await this.activate()
    if (!entered) return { success: false, error: 'Failed to activate outbound proxy.' }
    return { success: true, node: this.getEgressNodeName() }
  }

  async disable(): Promise<{ success: boolean }> {
    await this.resetToDirect()
    return { success: true }
  }

  private async prepareGroupPool(settings: OutboundProxySettings): Promise<boolean> {
    const source = this.getActiveSource(settings)
    if (!source) return false
    const probe = await source.probe()
    if (!probe.available) return false
    // Leased sources acquire per group lazily; a reachable gateway is enough.
    if (this.isAcquireMode(source)) return true
    await this.refreshPool(source)
    return this.pool.length > 0
  }

  private async enterProxyMode(gen: number): Promise<boolean> {
    const settings = this.getSettings()
    const source = this.getActiveSource(settings)
    if (!source) {
      this.log('No egress source configured; keeping direct connection')
      this.noteFailure()
      return false
    }

    const probe = await source.probe()
    if (gen !== this.generation) return false
    if (!probe.available) {
      this.log(`Egress source unavailable: ${probe.error ?? 'unknown'}`)
      this.noteFailure()
      return false
    }

    if (!this.isAcquireMode(source)) {
      await this.refreshPool(source)
      if (gen !== this.generation) return false
      if (this.pool.length === 0) {
        this.log('Egress source reported no exits; keeping direct connection')
        this.noteFailure()
        return false
      }
    }

    const exit = await this.pickUsableExit(source, settings, gen)
    if (gen !== this.generation) return false
    if (!exit) {
      this.log('No usable exit verified; keeping direct connection')
      this.noteFailure()
      return false
    }

    this.globalExit = exit
    this.proxyMode = true
    this.noteSuccess()
    this.scheduleExpiryRotation(exit, settings)
    this.log(
      `Routing outbound traffic through exit: ${exit.name ?? exit.id} (${this.getProxyUrl()})`,
    )
    return true
  }

  /** Single-flight, throttled rotation of the global single exit. */
  async rotateProxy(): Promise<string | null> {
    if (this.rotationPromise) return this.rotationPromise
    const settings = this.getSettings()
    const minInterval = clampNumber(
      settings.rotation.rotateMinIntervalMs,
      MIN_ROTATE_INTERVAL_MS,
      0,
      600000,
    )
    if (Date.now() - this.lastRotateAt < minInterval) {
      return this.getEgressNodeName()
    }

    const gen = this.generation
    const promise = this.doRotateProxy(gen)
    this.rotationPromise = promise
    void promise.finally(() => {
      if (this.rotationPromise === promise) this.rotationPromise = null
    })
    return promise
  }

  private async doRotateProxy(gen: number): Promise<string | null> {
    const settings = this.getSettings()
    const source = this.getActiveSource(settings)
    if (!source) return null
    const acquireMode = this.isAcquireMode(source)
    if (!acquireMode && this.pool.length === 0) return null

    // Release the current selection so another exit can be chosen. Leased
    // sources delete the old IP (it is never returned to the pool).
    if (this.globalExit) {
      this.allocator.release(this.globalExit.id)
      if (acquireMode) {
        const previous = this.globalExit
        this.globalExit = null
        if (source.disposeExit) await source.disposeExit(previous)
      }
    }

    const exit = await this.pickUsableExit(source, settings, gen)
    if (gen !== this.generation) return null
    if (!exit) {
      if (acquireMode) {
        this.globalExit = null
        this.proxyMode = false
        this.log('No replacement exit acquired; outbound proxy idle')
      } else {
        this.log('All exits failed verification; keeping current selection')
      }
      return null
    }

    this.globalExit = exit
    this.proxyMode = true
    this.lastRotateAt = Date.now()
    this.globalFailureCount = 0
    this.scheduleExpiryRotation(exit, settings)
    this.log(`Rotated outbound exit to: ${exit.name ?? exit.id}`)
    return exit.name ?? exit.id
  }

  async ensureProxyForRequest(_timeoutMs = 5000): Promise<boolean> {
    return this.activate()
  }

  private scheduleExpiryRotation(exit: EgressExit, settings: OutboundProxySettings): void {
    this.scheduler.cancel()
    if (!exit.expiresAt || settings.rotation.rotateEarlySeconds <= 0) return
    this.scheduler.schedule(exit.expiresAt, settings.rotation.rotateEarlySeconds, () => {
      void this.rotateProxy()
    })
  }

  async resetToDirect(): Promise<void> {
    this.scheduler.cancel()
    const source = this.activeSource
    this.resetRuntime()
    if (source) {
      try {
        await source.deactivate()
      } catch {
        // ignore restore failures
      }
    }
    this.log('Outbound traffic restored to direct connection')
  }

  // ---------- per-account routing ----------

  /**
   * Resolve the exit an account must route through, or null for a strict direct
   * connection.
   *
   * - master switch off -> null
   * - group assignment off -> the single global exit (activated on demand)
   * - group assignment on -> the account group's dynamically allocated exit
   */
  async resolveExitForAccount(providerId: string, accountId: string): Promise<EgressExit | null> {
    const settings = this.getSettings()
    if (!settings.enabled || !this.deps) return null

    if (!settings.groupAssignmentEnabled) {
      if (!this.proxyMode || !this.globalExit) {
        const active = await this.activate()
        if (!active && EGRESS_FAIL_FAST) {
          throw new EgressUnavailableError(
            'Outbound proxy is enabled but no exit could be activated.',
          )
        }
      }
      return this.proxyMode ? this.globalExit : null
    }

    const groupId = this.deps.getProviderAssignment(providerId)?.[accountId]
    if (!groupId) return null
    return this.ensureGroupExit(groupId)
  }

  /** The group id assigned to an account, or null for the direct group. */
  getAssignedGroupId(providerId: string, accountId: string): string | null {
    return this.deps?.getProviderAssignment(providerId)?.[accountId] ?? null
  }

  /** Single-flight, lazy allocation of a group's dynamic exit. */
  private ensureGroupExit(groupId: string): Promise<EgressExit | null> {
    const existing = this.groupExits.get(groupId)
    if (existing) return Promise.resolve(existing)

    const pending = this.groupEnsurePromises.get(groupId)
    if (pending) return pending

    const gen = this.generation
    const promise = this.doEnsureGroupExit(groupId, gen)
    this.groupEnsurePromises.set(groupId, promise)
    void promise.finally(() => {
      if (this.groupEnsurePromises.get(groupId) === promise) {
        this.groupEnsurePromises.delete(groupId)
      }
    })
    return promise
  }

  private async doEnsureGroupExit(groupId: string, gen: number): Promise<EgressExit | null> {
    const settings = this.getSettings()
    const source = this.getActiveSource(settings)
    if (!source) return null

    if (this.isAcquireMode(source)) {
      const leased = await this.acquireUsableExit(source, settings, gen)
      if (gen !== this.generation || !leased) return null
      this.groupExits.set(groupId, leased)
      this.groupFailureCounts.set(groupId, 0)
      this.log(`Group ${groupId} assigned exit: ${leased.name ?? leased.id}`)
      return leased
    }

    if (this.pool.length === 0) await this.refreshPool(source)
    if (gen !== this.generation) return null
    if (this.pool.length === 0) {
      this.log(`No exits available for group ${groupId}; falling back to direct`)
      return null
    }

    const exit = await this.scanTable(source, settings, gen)
    if (!exit) return null
    this.groupExits.set(groupId, exit)
    this.groupFailureCounts.set(groupId, 0)
    this.log(`Group ${groupId} assigned exit: ${exit.name ?? exit.id}`)
    return exit
  }

  /** Pre-allocate dynamic exits for every group (used by the assignment UI). */
  async warmGroupExits(): Promise<void> {
    const settings = this.getSettings()
    if (!settings.enabled || !settings.groupAssignmentEnabled) return
    for (const group of settings.groups) {
      await this.ensureGroupExit(group.id)
    }
  }

  /**
   * Rotate the dynamic exit used by one group without touching the global
   * single-exit selection. Single-flight and throttled per group.
   */
  async rotateGroup(groupId: string): Promise<string | null> {
    const pending = this.groupRotatePromises.get(groupId)
    if (pending) return pending

    const last = this.lastGroupRotateAt.get(groupId) ?? 0
    const minInterval = clampNumber(
      this.getSettings().rotation.rotateMinIntervalMs,
      MIN_ROTATE_INTERVAL_MS,
      0,
      600000,
    )
    if (Date.now() - last < minInterval) {
      const current = this.groupExits.get(groupId)
      return current ? (current.name ?? current.id) : null
    }

    const gen = this.generation
    const promise = this.doRotateGroup(groupId, gen)
    this.groupRotatePromises.set(groupId, promise)
    void promise.finally(() => {
      if (this.groupRotatePromises.get(groupId) === promise) {
        this.groupRotatePromises.delete(groupId)
      }
    })
    return promise
  }

  private async doRotateGroup(groupId: string, gen: number): Promise<string | null> {
    const settings = this.getSettings()
    const source = this.getActiveSource(settings)
    if (!source) return null
    if (this.pool.length === 0) await this.refreshPool(source)
    if (gen !== this.generation) return null

    const current = this.groupExits.get(groupId)
    if (current) {
      this.allocator.release(current.id)
      if (source.disposeExit) await source.disposeExit(current)
    }
    this.groupExits.delete(groupId)

    const exit = await this.doEnsureGroupExit(groupId, gen)
    if (!exit) return null
    this.lastGroupRotateAt.set(groupId, Date.now())
    this.log(`Rotated exit for group ${groupId} to: ${exit.name ?? exit.id}`)
    return exit.name ?? exit.id
  }

  // ---------- failure-driven rotation ----------

  private resolveFailureThreshold(): number {
    return clampInt(this.getSettings().rotation.rotateAfterFailures, 2, 1, 1000)
  }

  /**
   * Record a proxy-routable failure for the single global exit. The exit is
   * rotated only after `rotateAfterFailures` consecutive failures; a success
   * (`noteRequestSuccess`) resets the counter.
   */
  async noteProxyFailure(): Promise<string | null> {
    const threshold = this.resolveFailureThreshold()
    this.globalFailureCount += 1
    if (this.globalFailureCount < threshold) {
      this.log(`Proxy failure ${this.globalFailureCount}/${threshold}; keeping current exit`)
      return this.getEgressNodeName()
    }
    return this.rotateProxy()
  }

  /** Same as `noteProxyFailure`, tracked independently for one group. */
  async noteGroupFailure(groupId: string): Promise<string | null> {
    const threshold = this.resolveFailureThreshold()
    const count = (this.groupFailureCounts.get(groupId) ?? 0) + 1
    this.groupFailureCounts.set(groupId, count)
    if (count < threshold) {
      const current = this.groupExits.get(groupId)
      this.log(`Proxy failure ${count}/${threshold} for group ${groupId}; keeping current exit`)
      return current ? (current.name ?? current.id) : null
    }
    return this.rotateGroup(groupId)
  }

  /** Reset the consecutive-failure counter after a successful request. */
  noteRequestSuccess(providerId: string, accountId: string): void {
    const settings = this.getSettings()
    if (settings.groupAssignmentEnabled) {
      const groupId = this.deps?.getProviderAssignment(providerId)?.[accountId]
      if (!groupId) return
      this.groupFailureCounts.delete(groupId)
      return
    }
    this.globalFailureCount = 0
  }

  // ---------- assignment ----------

  getAssignmentOverview(providerId: string): AssignmentOverview {
    const settings = this.getSettings()
    const assignment = { ...(this.deps?.getProviderAssignment(providerId) ?? {}) }
    const providerAccountIds = this.deps?.getAccountIds(providerId) ?? []
    const providerIds = this.deps?.listProviderIds() ?? []

    const globalByGroup: Record<string, number> = {}
    let globalTotal = 0
    for (const pid of providerIds) {
      const providerAssignment = this.deps?.getProviderAssignment(pid) ?? {}
      for (const accountId of this.deps?.getAccountIds(pid) ?? []) {
        globalTotal += 1
        const group = providerAssignment[accountId] ?? DIRECT_GROUP
        globalByGroup[group] = (globalByGroup[group] ?? 0) + 1
      }
    }

    const providerByGroup: Record<string, number> = {}
    for (const accountId of providerAccountIds) {
      const group = assignment[accountId] ?? DIRECT_GROUP
      providerByGroup[group] = (providerByGroup[group] ?? 0) + 1
    }

    const groupExits: Record<string, EgressExit | null> = {}
    for (const group of settings.groups) {
      groupExits[group.id] = this.groupExits.get(group.id) ?? null
    }

    return {
      groups: settings.groups.map((group) => ({ ...group })),
      groupAssignmentEnabled: settings.groupAssignmentEnabled,
      assignment,
      providerTotals: { total: providerAccountIds.length, byGroup: providerByGroup },
      globalTotals: { total: globalTotal, byGroup: globalByGroup },
      groupExits,
    }
  }

  /**
   * Fill the provider's currently-unassigned accounts into existing groups
   * (skipping full ones) and create new groups when all are full. Already
   * assigned accounts and existing groups are left untouched.
   */
  async autoAssign(
    providerId: string,
    perGroupLimit: number,
    countScope: ProxyCountScope,
  ): Promise<AutoAssignResult> {
    if (!this.deps) return { assignment: {}, groups: [] }

    const settings = this.getSettings()
    const groups: ProxyGroup[] = settings.groups.map((group) => ({ ...group }))
    const limit = Math.max(1, perGroupLimit || 10)

    const providerIds = this.deps.listProviderIds()
    const scopeProviders = countScope === 'provider' ? [providerId] : providerIds
    const counts = new Map<string, number>()
    for (const group of groups) counts.set(group.id, 0)

    for (const pid of scopeProviders) {
      const providerAssignment = this.deps.getProviderAssignment(pid) ?? {}
      for (const accountId of this.deps.getAccountIds(pid)) {
        const group = providerAssignment[accountId]
        if (group && counts.has(group)) {
          counts.set(group, (counts.get(group) ?? 0) + 1)
        }
      }
    }

    const assignment = { ...(this.deps.getProviderAssignment(providerId) ?? {}) }
    const providerName = this.deps.getProviderName(providerId) || 'Group'
    let created = 0

    for (const accountId of this.deps.getAccountIds(providerId)) {
      if (assignment[accountId]) continue

      let target = groups.find((group) => (counts.get(group.id) ?? 0) < limit)
      if (!target) {
        created += 1
        target = {
          id: `grp-${Date.now().toString(36)}-${created}`,
          name: `${providerName} #${groups.length + 1}`,
        }
        groups.push(target)
        counts.set(target.id, 0)
      }

      assignment[accountId] = target.id
      counts.set(target.id, (counts.get(target.id) ?? 0) + 1)
    }

    return { assignment, groups }
  }

  async reload(): Promise<void> {
    const settings = this.getSettings()
    if (!settings.enabled) return
    const source = this.getActiveSource(settings)
    if (!source) return
    if (this.isAcquireMode(source)) return
    await this.refreshPool(source)
  }

  private log(message: string): void {
    console.log(`[Egress] ${message}`)
    this.deps?.logger.info(`[Egress] ${message}`)
  }
}

export const egressManager = new EgressManager()
export default egressManager
