/**
 * Perplexity provider module.
 */
import perplexityConfig from './config.ts'
import { PerplexityAdapter } from './adapter.ts'
import { createPerplexityForwarder } from './forwarder.ts'
import { PerplexityAdapter as PerplexityOAuthAdapter } from './oauth.ts'
import { getProviderToolProfile } from '../common/toolCalling'
import { checkPerplexityToken } from './tokenCheck.ts'
import type { ProviderModule } from '../types.ts'

export const perplexityModule: ProviderModule = {
  id: 'perplexity',
  config: perplexityConfig,
  matches: PerplexityAdapter.isPerplexityProvider,
  createForwarder: createPerplexityForwarder,
  oauth: {
    factory: (config) => new PerplexityOAuthAdapter(config),
    authMethods: ['manual', 'cookie'],
  },
  tokenExtraction: {
    loginUrl: 'https://www.perplexity.ai',
    tokenSources: [
      { type: 'cookie', key: '__Secure-next-auth.session-token' },
      { type: 'cookie', key: 'next-auth.session-token' },
    ],
    targetDomains: ['.perplexity.ai', 'perplexity.ai'],
    successUrlPatterns: [/perplexity\.ai/i],
    windowTitle: 'Perplexity Login - Please click Sign In to login',
  },
  tokenChecker: checkPerplexityToken,
  normalizeOAuthCredentials: (credentials) => {
    const secure = credentials['__Secure-next-auth.session-token']
    if (secure) return { sessionToken: secure }
    const plain = credentials['next-auth.session-token']
    if (plain) return { sessionToken: plain }
    return credentials
  },
  capabilities: {
    clearChats: async (provider, account) =>
      new PerplexityAdapter(provider, account).deleteAllChats(),
  },
  toolProfile: getProviderToolProfile('perplexity'),
}

export default perplexityModule
