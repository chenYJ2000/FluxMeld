/**
 * MiniMax provider module.
 */
import minimaxConfig from './config.ts'
import { MiniMaxAdapter } from './adapter.ts'
import { createMiniMaxForwarder } from './forwarder.ts'
import { MiniMaxAdapter as MiniMaxOAuthAdapter } from './oauth.ts'
import { getProviderToolProfile } from '../../proxy/toolCalling/providerProfiles.ts'
import { checkMiniMaxToken } from './tokenCheck.ts'
import type { ProviderModule } from '../types.ts'

export const minimaxModule: ProviderModule = {
  id: 'minimax',
  config: minimaxConfig,
  matches: MiniMaxAdapter.isMiniMaxProvider,
  createForwarder: createMiniMaxForwarder,
  oauth: {
    factory: (config) => new MiniMaxOAuthAdapter(config),
    authMethods: ['manual'],
  },
  tokenExtraction: {
    loginUrl: 'https://agent.minimaxi.com',
    tokenSources: [
      { type: 'localStorage', key: '_token' },
      { type: 'localStorage', key: 'user_detail_agent' },
    ],
    targetDomains: ['.minimaxi.com', 'minimaxi.com'],
    successUrlPatterns: [/agent\.minimaxi\.com/i],
    windowTitle: 'MiniMax Login',
  },
  tokenChecker: checkMiniMaxToken,
  capabilities: {
    clearChats: async (provider, account) =>
      new MiniMaxAdapter(provider, account).deleteAllChats(),
    credits: async (provider, account) => new MiniMaxAdapter(provider, account).getCredits(),
  },
  toolProfile: getProviderToolProfile('minimax'),
}

export default minimaxModule
