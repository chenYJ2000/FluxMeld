/**
 * Qwen (domestic) provider module.
 */
import qwenConfig from './config.ts'
import { QwenAdapter } from './adapter.ts'
import { createQwenForwarder } from './forwarder.ts'
import { QwenAdapter as QwenOAuthAdapter } from './oauth.ts'
import { getProviderToolProfile } from '../common/toolCalling'
import { checkQwenToken } from './tokenCheck.ts'
import type { ProviderModule } from '../types.ts'

export const qwenModule: ProviderModule = {
  id: 'qwen',
  config: qwenConfig,
  matches: QwenAdapter.isQwenProvider,
  createForwarder: createQwenForwarder,
  oauth: {
    factory: (config) => new QwenOAuthAdapter(config),
    authMethods: ['manual', 'cookie'],
  },
  tokenExtraction: {
    loginUrl: 'https://www.qianwen.com',
    tokenSources: [{ type: 'cookie', key: 'tongyi_sso_ticket' }],
    targetDomains: ['.qianwen.com', 'qianwen.com'],
    successUrlPatterns: [/qianwen\.com/i],
    windowTitle: 'Qwen Login',
  },
  tokenChecker: checkQwenToken,
  normalizeOAuthCredentials: (credentials) =>
    credentials.tongyi_sso_ticket ? { ticket: credentials.tongyi_sso_ticket } : credentials,
  capabilities: {
    clearChats: async (provider, account) => new QwenAdapter(provider, account).deleteAllChats(),
  },
  toolProfile: getProviderToolProfile('qwen'),
}

export default qwenModule
