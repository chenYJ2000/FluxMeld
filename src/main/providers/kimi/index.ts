/**
 * Kimi provider module.
 */
import kimiConfig from './config.ts'
import { KimiAdapter } from './adapter.ts'
import { createKimiForwarder } from './forwarder.ts'
import { KimiAdapter as KimiOAuthAdapter } from './oauth.ts'
import { getProviderToolProfile } from '../common/toolCalling'
import { checkKimiToken } from './tokenCheck.ts'
import type { ProviderModule } from '../types.ts'

export const kimiModule: ProviderModule = {
  id: 'kimi',
  config: kimiConfig,
  matches: KimiAdapter.isKimiProvider,
  createForwarder: createKimiForwarder,
  oauth: {
    factory: (config) => new KimiOAuthAdapter(config),
    authMethods: ['manual'],
  },
  tokenExtraction: {
    loginUrl: 'https://www.kimi.com',
    tokenSources: [
      {
        type: 'networkHeader',
        key: 'token',
        urlPattern: '*://*.kimi.com/*',
        extractPattern: '^Bearer\\s+(.+)$',
      },
    ],
    targetDomains: ['.kimi.com', 'kimi.com'],
    successUrlPatterns: [/kimi\.com/i],
    windowTitle: 'Kimi Login',
  },
  tokenChecker: checkKimiToken,
  capabilities: {
    clearChats: async (provider, account) => new KimiAdapter(provider, account).deleteAllChats(),
  },
  toolProfile: getProviderToolProfile('kimi'),
}

export default kimiModule
