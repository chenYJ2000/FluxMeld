/**
 * Egress plugin contracts.
 *
 * An `EgressSourceModule` is the single, self-contained entry point for one way
 * of producing outbound proxy exits (Clash external controller, a JSON config
 * file, a future IP pool, ...). Shared orchestrators consume sources exclusively
 * through `egress/registry.ts` and never branch on a source id.
 *
 * Terminology:
 * - source: a pluggable provider of proxy exits (Clash / config file / IP pool)
 * - exit: one concrete usable outbound proxy (host/port/protocol/credentials)
 * - group: a set of accounts that share one exit (rendered as a column)
 */

export type EgressProtocol = 'http' | 'https' | 'socks5' | 'socks5h'

/** One concrete outbound proxy the forwarder can route a request through. */
export interface EgressExit {
  /** Stable identity used for allocation/logging (Clash node name / file entry). */
  id: string
  /** Human readable label for logs and the UI. */
  name?: string
  protocol: EgressProtocol
  host: string
  port: number
  username?: string
  password?: string
  /** Absolute epoch ms at which this exit stops working; undefined = no expiry. */
  expiresAt?: number
}

/** Serializable field descriptor that drives the generic source settings UI. */
export type EgressFieldType = 'text' | 'password' | 'number' | 'boolean' | 'file' | 'select'

export interface EgressFieldOption {
  value: string
  labelKey: string
}

export interface EgressFieldDescriptor {
  key: string
  type: EgressFieldType
  labelKey: string
  placeholder?: string
  helpKey?: string
  options?: EgressFieldOption[]
  defaultValue?: string | number | boolean
}

/** What a source can do; consumed by the manager and the renderer. */
export interface EgressSourceCapabilities {
  /** Can switch exits at runtime. */
  rotate: boolean
  /** Can enumerate selectable exits. */
  listExits: boolean
  /** Exits have a lifetime and may expire (IP pools). */
  expiry: boolean
  /** Can be enabled proactively rather than only on-demand. */
  alwaysOn: boolean
}

export interface EgressSourceModuleMeta {
  /** Source module id; must be unique. */
  id: string
  /** i18n key for the display name. */
  labelKey: string
  /** i18n key for a short description. */
  descriptionKey?: string
  /** Serializable settings fields for the generic UI. */
  fields: EgressFieldDescriptor[]
  capabilities: EgressSourceCapabilities
}

/**
 * Serializable settings shared with the renderer. Defined in `shared/types.ts`
 * so main and renderer use a single source of truth.
 */
import type { RotationPolicy } from '../../shared/types.ts'
export type { RotationPolicy, EgressSourceConfig } from '../../shared/types.ts'

export interface EgressLogger {
  info(message: string): void
  warn(message: string): void
}

export interface EgressProbeResult {
  available: boolean
  error?: string
  details?: Record<string, unknown>
}

/** Host capabilities injected into every source instance. */
export interface EgressServices {
  getSettings(): Record<string, unknown>
  rotation: RotationPolicy
  logger: EgressLogger
}

/**
 * A runtime source instance. The manager owns allocation/rotation; a source only
 * has to expose its exits and make a chosen exit effective.
 */
export interface EgressSource {
  readonly meta: EgressSourceModuleMeta
  /** Can this source provide exits right now? */
  probe(): Promise<EgressProbeResult>
  /** Enumerate the currently available exits (ordered as the source prefers). */
  listExits(): Promise<EgressExit[]>
  /** Make the given exit effective (Clash: switch node; file: no-op). */
  apply(exit: EgressExit): Promise<boolean>
  /** Release source-side state and restore the previous network configuration. */
  deactivate(): Promise<void>
  /** Optional source-specific verification; falls back to the shared verifier. */
  verifyExit?(exit: EgressExit): Promise<boolean>
}

export interface EgressSourceModule {
  readonly meta: EgressSourceModuleMeta
  createSource(services: EgressServices): EgressSource
}
