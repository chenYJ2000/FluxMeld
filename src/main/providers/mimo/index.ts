/**
 * Mimo provider module.
 */
import mimoConfig from './config.ts'
import { MimoAdapter } from './adapter.ts'
import { createMimoForwarder } from './forwarder.ts'
import { MimoAdapter as MimoOAuthAdapter } from './oauth.ts'
import { getProviderToolProfile } from '../../proxy/toolCalling/providerProfiles.ts'
import { checkMimoToken } from './tokenCheck.ts'
import type { ProviderModule } from '../types.ts'

export const mimoModule: ProviderModule = {
  id: 'mimo',
  config: mimoConfig,
  matches: MimoAdapter.isMimoProvider,
  createForwarder: createMimoForwarder,
  oauth: {
    factory: (config) => new MimoOAuthAdapter(config),
    authMethods: ['manual', 'cookie'],
  },
  tokenExtraction: {
    loginUrl: 'https://aistudio.xiaomimimo.com',
    tokenSources: [
      { type: 'cookie', key: 'serviceToken' },
      { type: 'cookie', key: 'userId' },
      { type: 'cookie', key: 'xiaomichatbot_ph' },
    ],
    targetDomains: ['.xiaomimimo.com', 'xiaomimimo.com'],
    successUrlPatterns: [/aistudio\.xiaomimimo\.com/i],
    windowTitle: 'Mimo AI Studio Login',
  },
  tokenChecker: checkMimoToken,
  normalizeOAuthCredentials: (credentials) => {
    const result: Record<string, string> = {}
    if (credentials.service_token) result.service_token = credentials.service_token
    else if (credentials.serviceToken) result.service_token = credentials.serviceToken
    if (credentials.user_id) result.user_id = credentials.user_id
    else if (credentials.userId) result.user_id = credentials.userId
    if (credentials.ph_token) result.ph_token = credentials.ph_token
    else if (credentials.xiaomichatbot_ph) result.ph_token = credentials.xiaomichatbot_ph
    return result
  },
  capabilities: {
    clearChats: async (provider, account) => new MimoAdapter(provider, account).deleteAllChats(),
  },
  toolProfile: getProviderToolProfile('mimo'),
}

export default mimoModule
