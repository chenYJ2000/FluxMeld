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
    // The chat endpoint sits behind Aliyun WAF, which rejects requests that
    // carry a valid token but lack the site's anti-bot cookies.
    collectCookies: true,
    targetDomains: ['.qwen.ai', 'qwen.ai', 'chat.qwen.ai'],
    successUrlPatterns: [/chat\.qwen\.ai/i, /qwen\.ai/i],
    windowTitle: 'Qwen AI Login',
  },
  tokenChecker: checkQwenAiToken,
  registration: {
    // Qwen AI (international) registers with an email address + emailed code.
    registrationUrl: 'https://chat.qwen.ai/auth',
    codeSource: 'email',
    // chat.qwen.ai resets TLS when routed through a system proxy; connect direct.
    forceDirectConnection: true,
    fields: [
      { value: 'email', selector: 'input[name="email"]' },
      { value: 'password', selector: 'input[type="password"]' },
      { value: 'code' },
    ],
    // Qwen AI renders the code as one box per digit.
    codeSegmentedSelector: '.qwenchat-verification-code-input-cell',
    windowTitle: 'Qwen AI Registration',
    descriptionKey: 'providers.qwenAiBatchRegisterDescription',
  },
  normalizeOAuthCredentials: (credentials) =>
    credentials.tongyi_sso_ticket ? { ticket: credentials.tongyi_sso_ticket } : credentials,
  capabilities: {
    clearChats: async (provider, account) => new QwenAiAdapter(provider, account).deleteAllChats(),
  },
  toolProfile: getProviderToolProfile('qwen-ai'),
}

export default qwenAiModule
