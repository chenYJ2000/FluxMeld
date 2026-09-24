import type { BuiltinProviderConfig } from '../../store/types'

export const kimiConfig: BuiltinProviderConfig = {
  id: 'kimi',
  name: 'Kimi (kimi.com)',
  type: 'builtin',
  authType: 'cookie',
  apiEndpoint: 'https://www.kimi.com',
  chatPath: '/apiv2/kimi.gateway.chat.v1.ChatService/Chat',
  headers: {
    'Content-Type': 'application/connect+json',
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Origin: 'https://www.kimi.com',
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Priority: 'u=1, i',
  },
  enabled: true,
  description: 'Kimi K3 and K2.6 AI assistants by Moonshot, with reasoning and web search support',
  supportedModels: ['Kimi-K3', 'Kimi-K2.6'],
  modelMappings: {
    'Kimi-K3': 'k3',
    'Kimi-K2.6': 'kimi-k2.6',
  },
  credentialFields: [
    {
      name: 'token',
      labelKey: 'kimi.accessToken',
      placeholderKey: 'kimi.accessTokenPlaceholder',
      helpTextKey: 'kimi.accessTokenHelp',
      label: 'Kimi 会话令牌',
      type: 'password',
      required: true,
      placeholder: '请输入当前有效的 kimi-auth 或 access_token',
      helpText:
        'kimi-auth 的 Cookie 保存期限可能晚于令牌实际到期时间；优先使用 Local Storage 中的 access_token，并同时填写 refresh_token 以自动续期',
    },
    {
      name: 'refresh_token',
      labelKey: 'kimi.refreshToken',
      placeholderKey: 'kimi.refreshTokenPlaceholder',
      helpTextKey: 'kimi.refreshTokenHelp',
      label: 'refresh_token',
      type: 'password',
      required: false,
      placeholder: '粘贴 www.kimi.com Local Storage 中的 refresh_token',
      helpText: '若网页保存了此字段，填写后 FluxMeld 可在 access_token 到期前自动续期',
    },
  ],
  tokenCheckEndpoint: '/',
  tokenCheckMethod: 'GET',
  capabilities: {
    clearChats: true,
    toolCalling: true,
    batchRegister: true,
    webBatchRegister: true,
  },
  ui: { iconKey: 'kimi', i18nPrefix: 'kimi' },
}

export default kimiConfig
