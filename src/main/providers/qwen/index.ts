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
    // Aliyun passport sets the SSO on .aliyun.com; qianwen.com carries the
    // tongyi ticket. Search both so either entry point yields the cookie.
    targetDomains: ['.qianwen.com', 'qianwen.com', '.aliyun.com', 'aliyun.com'],
    successUrlPatterns: [/qianwen\.com/i],
    windowTitle: 'Qwen Login',
  },
  tokenChecker: checkQwenToken,
  registration: {
    // Qwen (domestic) has no standalone signup page: accounts live in the
    // Aliyun passport, so registering == logging in with a new phone number.
    // The Aliyun unified login page shows phone login + the "免费注册" entry,
    // and the oauth_callback returns to qianwen.com so the tongyi SSO ticket
    // (the credential we extract) gets set.
    registrationUrl:
      'https://account.aliyun.com/login/login.htm?oauth_callback=https%3A%2F%2Fwww.qianwen.com',
    // Aliyun passport renders its form inside an iframe
    // (`passport.aliyun.com/havanaone/...`) whose inputs only have generic
    // placeholders, so target them by id. The send-code control is a text
    // button inside the phone input's addon.
    fields: [
      { value: 'phone', selector: '#loginId' },
      { value: 'code', selector: '#smsCode' },
    ],
    sendCodeSelector: '.next-input-group-addon button.next-btn',
    // Aliyun's login page defaults to 账密登录; activate the phone-login tab so
    // the #loginId / #smsCode form is displayed and can be filled.
    activateTabText: '手机号登录',
    windowTitle: 'Qwen Registration',
    smsKeyword: '通义千问',
  },
  normalizeOAuthCredentials: (credentials) =>
    credentials.tongyi_sso_ticket ? { ticket: credentials.tongyi_sso_ticket } : credentials,
  capabilities: {
    clearChats: async (provider, account) => new QwenAdapter(provider, account).deleteAllChats(),
  },
  toolProfile: getProviderToolProfile('qwen'),
}

export default qwenModule
