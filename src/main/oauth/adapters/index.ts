/**
 * OAuth Adapter Index
 * Export all provider authentication adapters
 */

export { BaseOAuthAdapter } from './base'
export { DeepSeekAdapter } from './deepseek'
export { GLMAdapter } from './glm'
export { KimiAdapter } from './kimi'
export { MimoAdapter } from './mimo'
export { MiniMaxAdapter } from './minimax'
export { PerplexityAdapter } from './perplexity'
export { QwenAdapter } from './qwen'
export { QwenAiAdapter } from './qwen-ai'
export { ZaiAdapter } from './zai'
import { BaseOAuthAdapter } from './base'
import { DeepSeekAdapter } from './deepseek'
import { GLMAdapter } from './glm'
import { KimiAdapter } from './kimi'
import { MimoAdapter } from './mimo'
import { MiniMaxAdapter } from './minimax'
import { PerplexityAdapter } from './perplexity'
import { QwenAdapter } from './qwen'
import { QwenAiAdapter } from './qwen-ai'
import { ZaiAdapter } from './zai'
import { ProviderType, AdapterConfig } from '../types'

type AdapterFactory = (config: AdapterConfig) => BaseOAuthAdapter

/**
 * Provider -> adapter factory registry. Adding a provider is a single entry
 * here rather than an edit to a switch statement.
 */
const ADAPTER_FACTORIES: Record<ProviderType, AdapterFactory> = {
  deepseek: (config) => new DeepSeekAdapter(config),
  glm: (config) => new GLMAdapter(config),
  kimi: (config) => new KimiAdapter(config),
  mimo: (config) => new MimoAdapter(config),
  minimax: (config) => new MiniMaxAdapter(config),
  perplexity: (config) => new PerplexityAdapter(config),
  qwen: (config) => new QwenAdapter(config),
  'qwen-ai': (config) => new QwenAiAdapter(config),
  zai: (config) => new ZaiAdapter(config),
}

const SUPPORTED_AUTH_METHODS: Record<ProviderType, string[]> = {
  deepseek: ['manual'],
  glm: ['manual'],
  kimi: ['manual'],
  mimo: ['manual', 'cookie'],
  minimax: ['manual'],
  perplexity: ['manual', 'cookie'],
  qwen: ['manual', 'cookie'],
  'qwen-ai': ['manual'],
  zai: ['manual'],
}

/**
 * Adapter factory function
 */
export function createAdapter(providerType: ProviderType, config: AdapterConfig): BaseOAuthAdapter {
  const factory = ADAPTER_FACTORIES[providerType]
  if (!factory) {
    throw new Error(`Unsupported provider type: ${providerType}`)
  }
  return factory(config)
}

/**
 * Get supported authentication methods for provider
 */
export function getSupportedAuthMethods(providerType: ProviderType): string[] {
  return SUPPORTED_AUTH_METHODS[providerType] ?? ['manual']
}
