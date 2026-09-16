/**
 * Egress source registry.
 *
 * The single registration point for egress sources. All shared orchestration
 * (the manager, IPC handlers, the renderer) consumes sources through this
 * module, so adding a source never requires editing shared code.
 */

import { clashSourceModule } from './clash/index.ts'
import { configFileSourceModule } from './config-file/index.ts'
import type {
  EgressServices,
  EgressSource,
  EgressSourceConfig,
  EgressSourceModule,
  EgressSourceModuleMeta,
} from './types.ts'

export type { EgressSourceModule } from './types.ts'

/** All registered egress source modules, in display order. */
export const egressSourceModules: EgressSourceModule[] = [clashSourceModule, configFileSourceModule]

const moduleMap: Record<string, EgressSourceModule> = Object.fromEntries(
  egressSourceModules.map((module) => [module.meta.id, module]),
)

export function getEgressSourceModule(id: string): EgressSourceModule | undefined {
  return moduleMap[id]
}

export function getEgressSourceModules(): EgressSourceModule[] {
  return egressSourceModules
}

/** Serializable metadata for every source, consumed by the renderer. */
export function getEgressSourceMetas(): EgressSourceModuleMeta[] {
  return egressSourceModules.map((module) => module.meta)
}

/** Build a source instance for a persisted source config. */
export function createEgressSource(
  config: EgressSourceConfig,
  base: Omit<EgressServices, 'getSettings'>,
): EgressSource | null {
  const module = moduleMap[config.sourceId]
  if (!module) return null
  return module.createSource({
    ...base,
    getSettings: () => config.settings ?? {},
  })
}
