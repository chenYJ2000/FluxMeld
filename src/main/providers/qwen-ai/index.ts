/**
 * Qwen AI (international) provider module.
 */
import qwenAiConfig from './config.ts'
import { QwenAiAdapter } from './adapter.ts'
import { createQwenAiForwarder } from './forwarder.ts'
import { QwenAiAdapter as QwenAiOAuthAdapter } from './oauth.ts'
import { getProviderToolProfile } from '../common/toolCalling'
import { checkQwenAiToken } from './tokenCheck.ts'
import type { ProviderModule } from '../types.ts'

export const qwenAiModule: ProviderModule = {
  id: 'qwen-ai',
  config: qwenAiConfig,
  matches: QwenAiAdapter.isQwenAiProvider,
  createForwarder: createQwenAiForwarder,
  oauth: {
    factory: (config) => new QwenAiOAuthAdapter(config),
    authMethods: ['manual'],
  },
  tokenExtraction: {
    loginUrl: 'https://chat.qwen.ai',
    tokenSources: [
      { type: 'localStorage', key: 'token' },
      { type: 'cookie', key: 'token' },
    ],
    targetDomains: ['.qwen.ai', 'qwen.ai', 'chat.qwen.ai'],
    successUrlPatterns: [/chat\.qwen\.ai/i, /qwen\.ai/i],
    windowTitle: 'Qwen AI Login',
  },
  tokenChecker: checkQwenAiToken,
  normalizeOAuthCredentials: (credentials) =>
    credentials.tongyi_sso_ticket ? { ticket: credentials.tongyi_sso_ticket } : credentials,
  capabilities: {
    clearChats: async (provider, account) =>
      new QwenAiAdapter(provider, account).deleteAllChats(),
  },
  toolProfile: getProviderToolProfile('qwen-ai'),
}

export default qwenAiModule
