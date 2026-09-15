/**
 * Provider Registry
 *
 * The single registration point for providers. Every shared orchestrator
 * (proxy forwarder, OAuth manager, provider checker, IPC handlers, store)
 * consumes providers through this module, so adding or changing a provider
 * never requires editing shared orchestration code.
 *
 * Each provider is registered exactly once (its `providers/<id>/index.ts`
 * module). All derived collections below are computed from `providerModules`.
 */

import { deepseekModule } from './deepseek/index.ts'
import { glmModule } from './glm/index.ts'
import { kimiModule } from './kimi/index.ts'
import { mimoModule } from './mimo/index.ts'
import { minimaxModule } from './minimax/index.ts'
import { perplexityModule } from './perplexity/index.ts'
import { qwenModule } from './qwen/index.ts'
import { qwenAiModule } from './qwen-ai/index.ts'
import { zaiModule } from './zai/index.ts'

import type { Provider } from '../../shared/types'
import type { ProviderModule, BuiltinProviderConfig } from './types.ts'
import type { ForwarderServices, ProviderForwarder } from '../proxy/forwarders/types.ts'
import type { BaseOAuthAdapter } from './common/oauthBase.ts'
import type { AdapterConfig, ProviderType } from '../oauth/types.ts'
import type { ProviderToolProfile } from '../proxy/toolCalling/providerProfiles.ts'

export type { ProviderModule } from './types.ts'

/** All registered provider modules, in display order. */
export const providerModules: ProviderModule[] = [
  deepseekModule,
  glmModule,
  kimiModule,
  qwenModule,
  qwenAiModule,
  zaiModule,
  minimaxModule,
  mimoModule,
  perplexityModule,
]

const providerModuleMap: Record<string, ProviderModule> = Object.fromEntries(
  providerModules.map((module) => [module.id, module]),
)

/** Get the module for a provider id, or `undefined` when unknown. */
export function getProviderModule(id: string): ProviderModule | undefined {
  return providerModuleMap[id]
}

/** All registered provider modules. */
export function getProviderModules(): ProviderModule[] {
  return providerModules
}

/** All built-in provider configs (single source of truth). */
export function getBuiltinProviders(): BuiltinProviderConfig[] {
  return providerModules.map((module) => module.config)
}

/** Built-in provider config lookup by id. */
export function getBuiltinProvider(id: string): BuiltinProviderConfig | undefined {
  return providerModuleMap[id]?.config
}

/** Build every provider forwarder, in registry order. */
export function createProviderForwarders(services: ForwarderServices): ProviderForwarder[] {
  return providerModules.map((module) => module.createForwarder(services))
}

/** Resolve the forwarder that owns a given provider record. */
export function findForwarderForProvider(
  provider: Provider,
  services: ForwarderServices,
): ProviderForwarder | undefined {
  const module = providerModuleMap[provider.id]
  if (!module || !module.matches(provider)) return undefined
  return module.createForwarder(services)
}

/** Create the OAuth adapter for a provider type. */
export function createOAuthAdapter(
  providerType: ProviderType,
  config: AdapterConfig,
): BaseOAuthAdapter {
  const factory = providerModuleMap[providerType]?.oauth?.factory
  if (!factory) {
    throw new Error(`Unsupported provider type: ${providerType}`)
  }
  return factory(config)
}

/** Supported authentication methods for a provider type. */
export function getSupportedAuthMethods(providerType: ProviderType): string[] {
  return providerModuleMap[providerType]?.oauth?.authMethods ?? ['manual']
}

/** Tool-calling profile for a provider. */
export function getProviderToolProfileFromRegistry(id: string): ProviderToolProfile | undefined {
  return providerModuleMap[id]?.toolProfile
}
