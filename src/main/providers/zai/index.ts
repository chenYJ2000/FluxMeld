/**
 * Z.ai (GLM international) provider module.
 */
import zaiConfig from './config.ts'
import { ZaiAdapter } from './adapter.ts'
import { createZaiForwarder } from './forwarder.ts'
import { ZaiAdapter as ZaiOAuthAdapter } from './oauth.ts'
import { getProviderToolProfile } from '../../proxy/toolCalling/providerProfiles.ts'
import type { ProviderModule } from '../types.ts'

export const zaiModule: ProviderModule = {
  id: 'zai',
  config: zaiConfig,
  matches: ZaiAdapter.isZaiProvider,
  createForwarder: createZaiForwarder,
  oauth: {
    factory: (config) => new ZaiOAuthAdapter(config),
    authMethods: ['manual'],
  },
  tokenExtraction: {
    loginUrl: 'https://chat.z.ai',
    tokenSources: [
      { type: 'localStorage', key: 'token' },
      { type: 'cookie', key: 'token' },
    ],
    targetDomains: ['.z.ai', 'z.ai', 'chat.z.ai'],
    successUrlPatterns: [/chat\.z\.ai/i, /z\.ai/i],
    windowTitle: 'Z.ai Login',
  },
  normalizeOAuthCredentials: (credentials) =>
    credentials.tongyi_sso_ticket ? { ticket: credentials.tongyi_sso_ticket } : credentials,
  capabilities: {
    clearChats: async (provider, account) => new ZaiAdapter(provider, account).deleteAllChats(),
  },
  toolProfile: getProviderToolProfile('zai'),
}

export default zaiModule
