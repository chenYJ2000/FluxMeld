import type { BuiltinProviderConfig } from '../../store/types'

export const kimiAiConfig: BuiltinProviderConfig = {
  id: 'kimi-ai',
  name: 'Kimi AI (kimi.ai)',
  type: 'builtin',
  authType: 'jwt',
  apiEndpoint: 'https://www.kimi.ai',
  chatPath: '/apiv2/kimi.gateway.chat.v1.ChatService/Chat',
  headers: {
    'Content-Type': 'application/connect+json',
    Accept: '*/*',
    Origin: 'https://www.kimi.ai',
  },
  enabled: true,
  description: 'Kimi international website with access and refresh tokens',
  supportedModels: ['Kimi-AI-K3', 'Kimi-AI-K2.6'],
  modelMappings: {
    'Kimi-AI-K3': 'k3',
    'Kimi-AI-K2.6': 'kimi-k2.6',
  },
  credentialFields: [
    {
      name: 'token',
      labelKey: 'kimi-ai.accessToken',
      placeholderKey: 'kimi-ai.accessTokenPlaceholder',
      helpTextKey: 'kimi-ai.accessTokenHelp',
      label: 'access_token',
      type: 'password',
      required: true,
      placeholder: '请输入 www.kimi.ai Local Storage 中的 access_token',
      helpText: '从 www.kimi.ai 的 Local Storage 复制 access_token 的值',
    },
    {
      name: 'refresh_token',
      labelKey: 'kimi-ai.refreshToken',
      placeholderKey: 'kimi-ai.refreshTokenPlaceholder',
      helpTextKey: 'kimi-ai.refreshTokenHelp',
      label: 'refresh_token',
      type: 'password',
      required: true,
      placeholder: '请输入 www.kimi.ai Local Storage 中的 refresh_token',
      helpText: '访问令牌过期后用于自动续期；请只粘贴字段值',
    },
  ],
  tokenCheckEndpoint: '/',
  tokenCheckMethod: 'GET',
  capabilities: {
    clearChats: true,
    toolCalling: true,
    batchRegister: false,
    webBatchRegister: true,
  },
  ui: { iconKey: 'kimi', i18nPrefix: 'kimi-ai' },
}

export default kimiAiConfig
