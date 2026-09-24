/**
 * Built-in provider config aggregation.
 *
 * This module intentionally imports only static provider configs (no adapters),
 * so the store/config layer stays free of proxy runtime dependencies. Provider
 * behaviour is registered separately in `providers/registry.ts`.
 *
 * NOTE: models/config lists are derived from `builtinProviders`; add a provider
 * by appending its config module to the array below.
 */
import deepseekConfig from '../deepseek/config.ts'
import glmConfig from '../glm/config.ts'
import kimiConfig from '../kimi/config.ts'
import kimiAiConfig from '../kimi-ai/config.ts'
import minimaxConfig from '../minimax/config.ts'
import mimoConfig from '../mimo/config.ts'
import perplexityConfig from '../perplexity/config.ts'
import qwenConfig from '../qwen/config.ts'
import qwenAiConfig from '../qwen-ai/config.ts'
import zaiConfig from '../zai/config.ts'
import type { BuiltinProviderConfig } from '../types.ts'

export const builtinProviders: BuiltinProviderConfig[] = [
  deepseekConfig,
  glmConfig,
  kimiConfig,
  kimiAiConfig,
  minimaxConfig,
  mimoConfig,
  perplexityConfig,
  qwenConfig,
  qwenAiConfig,
  zaiConfig,
]

export const builtinProviderMap: Record<string, BuiltinProviderConfig> = Object.fromEntries(
  builtinProviders.map((config) => [config.id, config]),
)

export function getBuiltinProvider(id: string): BuiltinProviderConfig | undefined {
  return builtinProviderMap[id]
}

export function getBuiltinProviders(): BuiltinProviderConfig[] {
  return builtinProviders
}

export default builtinProviders
