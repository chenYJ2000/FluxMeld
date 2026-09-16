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

/** Max candidate exits tried per activation/rotation. */
const MAX_EXIT_ATTEMPTS = 8
/** Exit verification timeout. */
const VERIFY_TIMEOUT_MS = 5000
/** Failure backoff: base and cap. */
const COOLDOWN_BASE_MS = 1000
const COOLDOWN_MAX_MS = 30000
/** Minimum interval between rotations (avoids thrashing the Clash node). */
const MIN_ROTATE_INTERVAL_MS = 3000

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
  private consecutiveFailures = 0
  private cooldownUntil = 0
  private lastRotateAt = 0
  private readonly lastGroupRotateAt = new Map<string, number>()

  setDeps(deps: EgressManagerDeps): void {
    this.deps = deps
  }

  /** Drop all runtime state so the next call rebuilds from config. */
  invalidateSource(): void {
    this.resetRuntime()
  }

  /** Clear the failure cooldown (manual enable, config save, successful check). */
  resetCooldown(): void {
    this.consecutiveFailures = 0
    this.cooldownUntil = 0
  }

  /** Forget a deleted group's runtime exit binding. */
  forgetGroup(groupId: string): void {
    const exit = this.groupExits.get(groupId)
    if (exit) this.allocator.release(exit.id)
    this.groupExits.delete(groupId)
    this.groupEnsurePromises.delete(groupId)
    this.groupRotatePromises.delete(groupId)
    this.lastGroupRotateAt.delete(groupId)
  }

  private resetRuntime(): void {
    this.generation += 1
    this.activationPromise = null
    this.rotationPromise = null
    this.groupEnsurePromises.clear()
    this.groupRotatePromises.clear()
    this.lastGroupRotateAt.clear()
    this.activeSource = null
    this.activeSourceConfigId = null
    this.pool = []
    this.groupExits.clear()
    this.globalExit = null
    this.proxyMode = false
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
    if (!config) return null
    if (this.activeSource && this.activeSourceConfigId === config.id) return this.activeSource

    this.activeSource = createEgressSource(config, this.buildServices(settings))
    this.activeSourceConfigId = config.id
    this.pool = []
    this.groupExits.clear()
    this.allocator.reset()
    return this.activeSource
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
    await this.refreshPool(source)
    return [...this.pool]
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
    return defaultVerifyExit(exit, { timeoutMs: VERIFY_TIMEOUT_MS })
  }

  /**
   * Apply each candidate before verifying it, so a source whose exits share one
   * local endpoint (Clash) can actually skip dead nodes. Failed candidates are
   * released; on total failure the previous exit is re-applied.
   */
  private async pickUsableExit(
    source: EgressSource,
    settings: OutboundProxySettings,
    gen: number,
  ): Promise<EgressExit | null> {
    const previous = this.globalExit
    const limit = Math.min(this.pool.length, MAX_EXIT_ATTEMPTS)
    const tried: EgressExit[] = []

    for (let i = 0; i < limit; i++) {
      if (gen !== this.generation) return null
      const exit = this.allocator.allocate(this.pool)
      if (!exit) break
      tried.push(exit)

      const applied = await source.apply(exit)
      if (gen !== this.generation) return null
      if (applied && (await this.verify(exit, source, settings))) {
        for (const candidate of tried) {
          if (candidate.id !== exit.id) this.allocator.release(candidate.id)
        }
        return exit
      }
      this.log(`Exit unusable, skipping: ${exit.id}`)
    }

    for (const candidate of tried) this.allocator.release(candidate.id)
    if (previous) {
      try {
        await source.apply(previous)
      } catch {
        // best-effort restore
      }
    }
    return null
  }

  private noteFailure(): void {
    this.consecutiveFailures += 1
    const delay = Math.min(
      COOLDOWN_BASE_MS * 2 ** Math.max(0, this.consecutiveFailures - 1),
      COOLDOWN_MAX_MS,
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

    await this.refreshPool(source)
    if (gen !== this.generation) return false
    if (this.pool.length === 0) {
      this.log('Egress source reported no exits; keeping direct connection')
      this.noteFailure()
      return false
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
    if (Date.now() - this.lastRotateAt < MIN_ROTATE_INTERVAL_MS) {
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
    if (!source || this.pool.length === 0) return null

    const exit = await this.pickUsableExit(source, settings, gen)
    if (gen !== this.generation) return null
    if (!exit) {
      this.log('All exits failed verification; keeping current selection')
      return null
    }

    this.globalExit = exit
    this.proxyMode = true
    this.lastRotateAt = Date.now()
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
    if (this.pool.length === 0) await this.refreshPool(source)
    if (gen !== this.generation) return null
    if (this.pool.length === 0) {
      this.log(`No exits available for group ${groupId}; falling back to direct`)
      return null
    }

    const limit = Math.min(this.pool.length, MAX_EXIT_ATTEMPTS)
    const tried: EgressExit[] = []

    for (let i = 0; i < limit; i++) {
      const exit = this.allocator.allocate(this.pool)
      if (!exit) break
      tried.push(exit)

      const applied = await source.apply(exit)
      if (gen !== this.generation) return null
      if (applied && (await this.verify(exit, source, settings))) {
        for (const candidate of tried) {
          if (candidate.id !== exit.id) this.allocator.release(candidate.id)
        }
        this.groupExits.set(groupId, exit)
        this.log(`Group ${groupId} assigned exit: ${exit.name ?? exit.id}`)
        return exit
      }
    }

    for (const candidate of tried) this.allocator.release(candidate.id)
    return null
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
    if (Date.now() - last < MIN_ROTATE_INTERVAL_MS) {
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
    if (current) this.allocator.release(current.id)
    this.groupExits.delete(groupId)

    const exit = await this.doEnsureGroupExit(groupId, gen)
    if (!exit) return null
    this.lastGroupRotateAt.set(groupId, Date.now())
    this.log(`Rotated exit for group ${groupId} to: ${exit.name ?? exit.id}`)
    return exit.name ?? exit.id
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
    await this.refreshPool(source)
  }

  private log(message: string): void {
    console.log(`[Egress] ${message}`)
    this.deps?.logger.info(`[Egress] ${message}`)
  }
}

export const egressManager = new EgressManager()
export default egressManager
