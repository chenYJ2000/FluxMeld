/**
 * GLM (Zhipu) provider module.
 */
import glmConfig from './config.ts'
import { GLMAdapter } from './adapter.ts'
import { createGLMForwarder } from './forwarder.ts'
import { GLMAdapter as GLMOAuthAdapter } from './oauth.ts'
import { getProviderToolProfile } from '../../proxy/toolCalling/providerProfiles.ts'
import { checkGLMToken } from './tokenCheck.ts'
import type { ProviderModule } from '../types.ts'

export const glmModule: ProviderModule = {
  id: 'glm',
  config: glmConfig,
  matches: GLMAdapter.isGLMProvider,
  createForwarder: createGLMForwarder,
  oauth: {
    factory: (config) => new GLMOAuthAdapter(config),
    authMethods: ['manual'],
  },
  tokenExtraction: {
    loginUrl: 'https://chatglm.cn',
    tokenSources: [{ type: 'cookie', key: 'chatglm_refresh_token' }],
    targetDomains: ['.chatglm.cn', 'chatglm.cn'],
    successUrlPatterns: [/chatglm\.cn/i],
    windowTitle: 'GLM Login',
  },
  tokenChecker: checkGLMToken,
  normalizeOAuthCredentials: (credentials) =>
    credentials.chatglm_refresh_token
      ? { refresh_token: credentials.chatglm_refresh_token }
      : credentials,
  capabilities: {
    clearChats: async (provider, account) => new GLMAdapter(provider, account).deleteAllChats(),
  },
  toolProfile: getProviderToolProfile('glm'),
}

export default glmModule
