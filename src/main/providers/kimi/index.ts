/**
 * Kimi provider module.
 */
import kimiConfig from './config.ts'
import { KimiAdapter } from './adapter.ts'
import { createKimiForwarder } from './forwarder.ts'
import { KimiAdapter as KimiOAuthAdapter } from './oauth.ts'
import { getProviderToolProfile } from '../common/toolCalling'
import { checkKimiToken } from './tokenCheck.ts'
import { maintainKimiSessions } from './maintenance.ts'
import { registerKimiOnWeb } from './webRegistration.ts'
import type { ProviderModule } from '../types.ts'

export const kimiModule: ProviderModule = {
  id: 'kimi',
  config: kimiConfig,
  matches: KimiAdapter.isKimiProvider,
  createForwarder: createKimiForwarder,
  oauth: {
    factory: (config) => new KimiOAuthAdapter(config),
    authMethods: ['manual', 'cookie'],
  },
  tokenExtraction: {
    loginUrl: 'https://www.kimi.com/login',
    tokenSources: [
      { type: 'localStorage', key: 'access_token' },
      { type: 'localStorage', key: 'refresh_token' },
      { type: 'cookie', key: 'kimi-auth' },
    ],
    requiredKeys: ['access_token', 'refresh_token'],
    loginAlternativeKeys: [['kimi-auth']],
    targetDomains: ['.kimi.com', 'kimi.com'],
    successUrlPatterns: [/kimi\.com/i],
    windowTitle: 'Kimi Login',
  },
  registration: {
    registrationUrl: 'https://www.kimi.com/login',
    fields: [
      { value: 'phone', selector: '[data-testid="login-phone-input"]' },
      { value: 'code', selector: '[data-testid="login-code-input"]' },
    ],
    windowTitle: 'Kimi Registration',
    requiresTermsConsent: true,
    termsCheckboxSelector: 'input[type="checkbox"]',
    sendCodeSelector: '[data-testid="login-send-code"]',
    submitSelector: '[data-testid="login-submit"]',
  },
  webRegistration: registerKimiOnWeb,
  tokenChecker: checkKimiToken,
  maintainSessions: maintainKimiSessions,
  normalizeOAuthCredentials: (credentials) => {
    const token =
      credentials.access_token ||
      credentials.accessToken ||
      credentials.token ||
      credentials['kimi-auth']
    const normalized: Record<string, string> = token ? { token } : {}
    if (credentials.refresh_token) normalized.refresh_token = credentials.refresh_token
    return normalized
  },
  capabilities: {
    clearChats: async (provider, account) => new KimiAdapter(provider, account).deleteAllChats(),
  },
  toolProfile: getProviderToolProfile('kimi'),
}

export default kimiModule
