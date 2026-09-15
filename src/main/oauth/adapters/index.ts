/**
 * OAuth adapter registry facade.
 *
 * Adapter classes remain exported for direct use/tests; factory + auth-method
 * lookups are delegated to `providers/registry.ts` so adding a provider only
 * requires a module entry, not an edit here.
 */

export { BaseOAuthAdapter } from '../../providers/common/oauthBase'
export { DeepSeekAdapter } from '../../providers/deepseek/oauth'
export { GLMAdapter } from '../../providers/glm/oauth'
export { KimiAdapter } from '../../providers/kimi/oauth'
export { MimoAdapter } from '../../providers/mimo/oauth'
export { MiniMaxAdapter } from '../../providers/minimax/oauth'
export { PerplexityAdapter } from '../../providers/perplexity/oauth'
export { QwenAdapter } from '../../providers/qwen/oauth'
export { QwenAiAdapter } from '../../providers/qwen-ai/oauth'
export { ZaiAdapter } from '../../providers/zai/oauth'

export {
  createOAuthAdapter as createAdapter,
  getSupportedAuthMethods,
} from '../../providers/registry.ts'
