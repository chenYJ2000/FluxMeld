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

  setDeps(deps: EgressManagerDeps): void {
    this.deps = deps
  }

  /** Drop cached source/pool state so the next call rebuilds from config. */
  invalidateSource(): void {
    this.activeSource = null
    this.activeSourceConfigId = null
    this.pool = []
    this.groupExits.clear()
    this.allocator.reset()
  }

  /** Forget a deleted group's runtime exit binding. */
  forgetGroup(groupId: string): void {
    const exit = this.groupExits.get(groupId)
    if (exit) this.allocator.release(exit.id)
    this.groupExits.delete(groupId)
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

  private allocateNext(pool: EgressExit[]): EgressExit | null {
    if (this.globalExit) this.allocator.release(this.globalExit.id)
    return this.allocator.allocate(pool)
  }

  private async verify(
    exit: EgressExit,
    source: EgressSource,
    settings: OutboundProxySettings,
  ): Promise<boolean> {
    if (!settings.rotation.verifyBeforeUse) return true
    if (source.verifyExit) return source.verifyExit(exit)
    return defaultVerifyExit(exit)
  }

  private async pickUsableExit(
    source: EgressSource,
    settings: OutboundProxySettings,
  ): Promise<EgressExit | null> {
    const total = this.pool.length
    for (let attempt = 0; attempt < total; attempt++) {
      const exit = this.allocateNext(this.pool)
      if (!exit) return null
      if (await this.verify(exit, source, settings)) return exit
      this.log(`Exit unusable, skipping: ${exit.id}`)
    }
    return null
  }

  async enable(): Promise<{ success: boolean; error?: string; node?: string | null }> {
    const settings = this.getSettings()
    if (settings.groupAssignmentEnabled) {
      const ready = await this.prepareGroupPool(settings)
      if (!ready) return { success: false, error: 'No usable egress exit available.' }
      return { success: true, node: null }
    }
    const entered = await this.enterProxyMode()
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

  async enterProxyMode(): Promise<boolean> {
    const settings = this.getSettings()
    const source = this.getActiveSource(settings)
    if (!source) {
      this.log('No egress source configured; keeping direct connection')
      return false
    }

    const probe = await source.probe()
    if (!probe.available) {
      this.log(`Egress source unavailable: ${probe.error ?? 'unknown'}`)
      return false
    }

    await this.refreshPool(source)
    if (this.pool.length === 0) {
      this.log('Egress source reported no exits; keeping direct connection')
      return false
    }

    const exit = await this.pickUsableExit(source, settings)
    if (!exit) {
      this.log('No usable exit verified; keeping direct connection')
      return false
    }

    const applied = await source.apply(exit)
    if (!applied) {
      this.log(`Failed to apply exit: ${exit.id}`)
      return false
    }

    this.globalExit = exit
    this.proxyMode = true
    this.scheduleExpiryRotation(exit, settings)
    this.log(
      `Routing outbound traffic through exit: ${exit.name ?? exit.id} (${this.getProxyUrl()})`,
    )
    return true
  }

  async rotateProxy(): Promise<string | null> {
    const settings = this.getSettings()
    const source = this.getActiveSource(settings)
    if (!source || this.pool.length === 0) return null

    const exit = await this.pickUsableExit(source, settings)
    if (!exit) {
      this.log('All exits failed verification; keeping current selection')
      return null
    }

    const applied = await source.apply(exit)
    if (!applied) return null

    this.globalExit = exit
    this.proxyMode = true
    this.scheduleExpiryRotation(exit, settings)
    this.log(`Rotated outbound exit to: ${exit.name ?? exit.id}`)
    return exit.name ?? exit.id
  }

  async ensureProxyForRequest(_timeoutMs = 5000): Promise<boolean> {
    if (this.proxyMode && this.globalExit) return true
    const result = await this.enterProxyMode()
    return result || (this.proxyMode && !!this.globalExit)
  }

  private scheduleExpiryRotation(exit: EgressExit, settings: OutboundProxySettings): void {
    this.scheduler.cancel()
    if (!exit.expiresAt || settings.rotation.rotateEarlySeconds <= 0) return
    this.scheduler.schedule(exit.expiresAt, settings.rotation.rotateEarlySeconds, () => {
      void this.rotateProxy()
    })
  }

  async resetToDirect(): Promise<void> {
    this.proxyMode = false
    this.scheduler.cancel()
    if (this.activeSource) {
      try {
        await this.activeSource.deactivate()
      } catch {
        // ignore restore failures
      }
    }
    if (this.globalExit) {
      this.allocator.release(this.globalExit.id)
    }
    for (const exit of this.groupExits.values()) {
      this.allocator.release(exit.id)
    }
    this.groupExits.clear()
    this.globalExit = null
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
        await this.enterProxyMode()
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

  /** Lazily allocate (and cache) the dynamic exit for a group. */
  private async ensureGroupExit(groupId: string): Promise<EgressExit | null> {
    const existing = this.groupExits.get(groupId)
    if (existing) return existing

    const settings = this.getSettings()
    const source = this.getActiveSource(settings)
    if (!source) return null
    if (this.pool.length === 0) await this.refreshPool(source)
    if (this.pool.length === 0) {
      this.log(`No exits available for group ${groupId}; falling back to direct`)
      return null
    }

    const exit = this.allocator.allocate(this.pool)
    if (!exit) return null
    await source.apply(exit)
    this.groupExits.set(groupId, exit)
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
   * single-exit selection. The binding is runtime-only.
   */
  async rotateGroup(groupId: string): Promise<string | null> {
    const settings = this.getSettings()
    const source = this.getActiveSource(settings)
    if (!source) return null
    if (this.pool.length === 0) await this.refreshPool(source)

    const current = this.groupExits.get(groupId)
    if (current) this.allocator.release(current.id)

    const next = this.allocator.allocate(this.pool)
    if (!next) return null

    await source.apply(next)
    this.groupExits.set(groupId, next)
    this.log(`Rotated exit for group ${groupId} to: ${next.name ?? next.id}`)
    return next.name ?? next.id
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
