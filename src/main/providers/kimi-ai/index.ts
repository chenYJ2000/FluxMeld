import kimiAiConfig from './config.ts'
import { KimiAdapter } from '../kimi/adapter.ts'
import { createKimiForwarder } from '../kimi/forwarder.ts'
import { KimiAiOAuthAdapter } from './oauth.ts'
import { checkKimiAiToken } from './tokenCheck.ts'
import { getProviderToolProfile } from '../common/toolCalling'
import { registerKimiAiOnWeb } from './webRegistration'
import { maintainKimiAiSessions } from './maintenance'
import type { ProviderModule } from '../types.ts'

export const kimiAiModule: ProviderModule = {
  id: 'kimi-ai',
  config: kimiAiConfig,
  matches: (provider) => provider.id === 'kimi-ai',
  createForwarder: (services) => createKimiForwarder(services, 'kimi-ai'),
  oauth: {
    factory: (config) => new KimiAiOAuthAdapter(config),
    authMethods: ['manual', 'token'],
  },
  tokenExtraction: {
    loginUrl: 'https://www.kimi.ai',
    tokenSources: [
      { type: 'localStorage', key: 'access_token' },
      { type: 'localStorage', key: 'refresh_token' },
    ],
    requiredKeys: ['access_token', 'refresh_token'],
    targetDomains: ['.kimi.ai', 'kimi.ai'],
    successUrlPatterns: [/kimi\.ai/i],
    windowTitle: 'Kimi AI Login',
  },
  registration: {
    registrationUrl: 'https://www.kimi.ai/',
    fields: [{ value: 'phone' }, { value: 'code' }],
    windowTitle: 'Kimi AI Registration',
    requiresTermsConsent: true,
  },
  webRegistration: registerKimiAiOnWeb,
  tokenChecker: checkKimiAiToken,
  maintainSessions: maintainKimiAiSessions,
  normalizeOAuthCredentials: (credentials) => {
    const token = credentials.access_token || credentials.token
    const refreshToken = credentials.refresh_token
    const normalized: Record<string, string> =
      token && refreshToken ? { token, refresh_token: refreshToken } : {}
    return normalized
  },
  capabilities: {
    clearChats: async (provider, account) => new KimiAdapter(provider, account).deleteAllChats(),
  },
  toolProfile: getProviderToolProfile('kimi'),
}

export default kimiAiModule
