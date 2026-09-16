/**
 * EgressManager
 *
 * The single orchestrator for outbound proxying. It:
 *   - owns the configured egress sources (from `outboundProxy` config),
 *   - allocates exits through the shared `ExitAllocator`,
 *   - applies the effective exit to each upstream request via a request-scoped
 *     async-local context (`runWithEgress`), never mutating global axios state,
 *   - implements the global on-demand fallback and per-account group routing.
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
  activeSourceId: string
  rotation: RotationPolicy
  sources: EgressSourceConfig[]
  maxAccountsPerGroup: number
}

export interface EgressManagerDeps {
  getSettings(): OutboundProxySettings
  getProviderAssignment(providerId: string): Record<string, string | null> | undefined
  getAccountIds(providerId: string): string[]
  logger: EgressLogger
}

const DEFAULT_ROTATION: RotationPolicy = {
  strategy: 'roundRobin',
  rotateEarlySeconds: 30,
  verifyBeforeUse: true,
}

const DEFAULT_SETTINGS: OutboundProxySettings = {
  enabled: false,
  activeSourceId: '',
  rotation: DEFAULT_ROTATION,
  sources: [],
  maxAccountsPerGroup: 10,
}

export class EgressManager {
  private proxyMode = false
  private globalExit: EgressExit | null = null
  private activeSource: EgressSource | null = null
  private activeSourceConfigId: string | null = null
  private readonly allocator = new ExitAllocator()
  private pool: EgressExit[] = []
  private readonly exitOverrides = new Map<string, EgressExit>()
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
    this.exitOverrides.clear()
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
    }
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
    this.exitOverrides.clear()
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
    return {
      enabled: this.proxyMode,
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

  async getExits(): Promise<EgressExit[]> {
    const settings = this.getSettings()
    const source = this.getActiveSource(settings)
    if (!source) return []
    await this.refreshPool(source)
    return [...this.pool]
  }

  getProxyPool(): EgressExit[] {
    return [...this.pool]
  }

  private async refreshPool(source: EgressSource): Promise<void> {
    this.pool = await source.listExits()
  }

  // ---------- activation ----------

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
    const entered = await this.enterProxyMode()
    if (!entered) return { success: false, error: 'Failed to activate outbound proxy.' }
    return { success: true, node: this.getEgressNodeName() }
  }

  async disable(): Promise<{ success: boolean }> {
    await this.resetToDirect()
    return { success: true }
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
    this.globalExit = null
    this.log('Outbound traffic restored to direct connection')
  }

  // ---------- per-account routing ----------

  /**
   * Resolve the exit an account must route through, or null for a strict direct
   * connection. When a provider has no proxy assignment configured at all, the
   * global on-demand fallback is used instead.
   */
  resolveExitForAccount(providerId: string, accountId: string): EgressExit | null {
    const settings = this.getSettings()
    if (!settings.enabled || !this.deps) return null

    const assignment = this.deps.getProviderAssignment(providerId)
    if (!assignment) {
      return this.proxyMode ? this.globalExit : null
    }

    const exitId = assignment[accountId]
    if (!exitId) return null
    return this.exitOverrides.get(exitId) ?? this.pool.find((exit) => exit.id === exitId) ?? null
  }

  /** Whether this provider has any per-account proxy assignment configured. */
  hasAssignmentMap(providerId: string): boolean {
    return this.deps?.getProviderAssignment(providerId) !== undefined
  }

  /** The exit id assigned to an account, or null for the direct group. */
  getAssignedExitId(providerId: string, accountId: string): string | null {
    return this.deps?.getProviderAssignment(providerId)?.[accountId] ?? null
  }

  /**
   * Rotate the exit used by one group (all accounts sharing `exitId`) without
   * touching the global on-demand exit. The override is runtime-only; persisted
   * assignments keep pointing at the group's configured exit.
   */
  async rotateExit(exitId: string): Promise<string | null> {
    const settings = this.getSettings()
    const source = this.getActiveSource(settings)
    if (!source) return null
    if (this.pool.length === 0) await this.refreshPool(source)

    const current = this.exitOverrides.get(exitId) ?? this.pool.find((exit) => exit.id === exitId)
    if (current) this.allocator.release(current.id)

    const next = this.allocator.allocate(this.pool)
    if (!next) return null

    this.exitOverrides.set(exitId, next)
    await source.apply(next)
    this.log(`Rotated exit for group ${exitId} to: ${next.name ?? next.id}`)
    return next.name ?? next.id
  }

  // ---------- assignment (Phase 2) ----------

  getAssignment(providerId: string): {
    assignment: Record<string, string | null>
    exits: EgressExit[]
  } {
    const assignment = this.deps?.getProviderAssignment(providerId) ?? {}
    return { assignment: { ...assignment }, exits: [...this.pool] }
  }

  async autoAssign(providerId: string): Promise<Record<string, string | null>> {
    const settings = this.getSettings()
    const source = this.getActiveSource(settings)
    if (!source || !this.deps) return {}

    await this.refreshPool(source)
    if (this.pool.length === 0) return {}

    const accounts = this.deps.getAccountIds(providerId)
    const maxPerGroup = Math.max(1, settings.maxAccountsPerGroup || 10)

    const result: Record<string, string | null> = {}
    for (let i = 0; i < accounts.length; i += maxPerGroup) {
      const exit = this.allocator.allocate(this.pool)
      const chunk = accounts.slice(i, i + maxPerGroup)
      for (const accountId of chunk) {
        result[accountId] = exit ? exit.id : null
      }
    }

    return result
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
