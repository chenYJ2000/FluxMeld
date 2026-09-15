/**
 * DeepSeek provider module.
 *
 * Single entry point for everything DeepSeek-specific. Shared orchestrators
 * consume this through `providers/registry.ts` and never branch on provider id.
 */
import deepseekConfig from './config.ts'
import { DeepSeekAdapter } from './adapter.ts'
import { createDeepSeekForwarder } from './forwarder.ts'
import { DeepSeekAdapter as DeepSeekOAuthAdapter } from './oauth.ts'
import { getProviderToolProfile } from '../common/toolCalling'
import { checkDeepSeekToken } from './tokenCheck.ts'
import type { ProviderModule } from '../types.ts'

export const deepseekModule: ProviderModule = {
  id: 'deepseek',
  config: deepseekConfig,
  matches: DeepSeekAdapter.isDeepSeekProvider,
  createForwarder: createDeepSeekForwarder,
  oauth: {
    factory: (config) => new DeepSeekOAuthAdapter(config),
    authMethods: ['manual'],
  },
  tokenExtraction: {
    loginUrl: 'https://chat.deepseek.com',
    tokenSources: [{ type: 'localStorage', key: 'userToken' }],
    targetDomains: ['.deepseek.com', 'deepseek.com'],
    successUrlPatterns: [/chat\.deepseek\.com/i],
    windowTitle: 'DeepSeek Login',
  },
  tokenChecker: checkDeepSeekToken,
  normalizeOAuthCredentials: (credentials) => {
    const raw = credentials.userToken
    if (!raw) return credentials
    let value = raw
    if (value.startsWith('{') && value.endsWith('}')) {
      try {
        const parsed = JSON.parse(value)
        if (parsed?.value) value = parsed.value
      } catch {
        // keep the raw value when it is not valid JSON
      }
    }
    return { token: value }
  },
  capabilities: {
    clearChats: async (provider, account) =>
      new DeepSeekAdapter(provider, account).deleteAllChats(),
  },
  toolProfile: getProviderToolProfile('deepseek'),
}

export default deepseekModule
