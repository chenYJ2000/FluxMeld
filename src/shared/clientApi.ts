/**
 * Transport-agnostic client API factory.
 *
 * The renderer talks to the backend exclusively through `window.electronAPI`.
 * This module builds that object from a `ClientTransport`, so the same API can
 * be backed by Electron IPC (preload) or HTTP + SSE (web bridge).
 */

import type {
  Provider,
  Account,
  ProxyStatus,
  ProviderCheckResult,
  OAuthResult,
  AuthType,
  CredentialField,
  LogLevel,
  LogEntry,
  ProviderVendor,
  AppConfig,
  SystemPrompt,
  PromptType,
  EffectiveModel,
} from './types'

export interface ClientTransport {
  invoke(channel: string, ...args: unknown[]): Promise<any>
  on(channel: string, callback: (...args: any[]) => void): () => void
  send(channel: string, ...args: unknown[]): void
}

export interface ClientApiOptions {
  /** 'web' hides desktop-only controls and uses same-origin management URLs. */
  platform?: 'electron' | 'web'
  /** Base URL for the management API. Defaults to same-origin in web mode. */
  managementBaseUrl?: string
}

interface OutboundProxyStatus {
  enabled: boolean
  controllerUrl: string | null
  proxyUrl: string
  node: string | null
}

interface OutboundProxyCheckResult {
  available: boolean
  controllerUrl: string | null
  proxyPorts: number[]
  error?: string
}

interface OutboundProxyActionResult {
  success: boolean
  error?: string
  node?: string | null
}

interface TokenValidationResult {
  valid: boolean
  tokenType?: string
  expiresAt?: number
  accountInfo?: {
    userId?: string
    email?: string
    name?: string
  }
  error?: string
}

interface CredentialInfo {
  type: string
  value: string
  expiresAt?: number
  refreshToken?: string
}

interface OAuthProgressEvent {
  status: 'idle' | 'pending' | 'success' | 'error' | 'cancelled'
  message: string
  progress?: number
  data?: Record<string, unknown>
}

interface LogFilter {
  level?: LogLevel | 'all'
  keyword?: string
  startTime?: number
  endTime?: number
  limit?: number
  offset?: number
}

interface LogStats {
  total: number
  info: number
  warn: number
  error: number
  debug: number
}

interface LogTrend {
  date: string
  total: number
  info: number
  warn: number
  error: number
}

interface RequestLogEntry {
  id: string
  timestamp: number
  status: 'success' | 'error'
  statusCode: number
  clientIp?: string
  egressNode?: string
  apiKey?: string
  method: string
  url: string
  model: string
  actualModel?: string
  providerId?: string
  providerName?: string
  accountId?: string
  accountName?: string
  requestBody?: string
  userInput?: string
  webSearch?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high'
  responseStatus: number
  responsePreview?: string
  responseBody?: string
  latency: number
  isStream: boolean
  errorMessage?: string
  errorStack?: string
}

interface RequestLogFilter {
  status?: 'success' | 'error'
  providerId?: string
  limit?: number
}

interface RequestLogStats {
  total: number
  success: number
  error: number
  todayTotal: number
  todaySuccess: number
  todayError: number
}

interface RequestLogTrend {
  date: string
  total: number
  success: number
  error: number
  avgLatency: number
}

interface PersistentStatistics {
  totalRequests: number
  successRequests: number
  failedRequests: number
  totalLatency: number
  lastUpdated: number
  modelUsage: Record<string, number>
  providerUsage: Record<string, number>
  accountUsage: Record<string, number>
  dailyStats: Record<string, DailyStatistics>
}

interface DailyStatistics {
  date: string
  totalRequests: number
  successRequests: number
  failedRequests: number
  totalLatency: number
  modelUsage: Record<string, number>
  providerUsage: Record<string, number>
}

interface UpdateProgressInfo {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

interface UpdateStatus {
  checking: boolean
  available: boolean
  downloading: boolean
  downloaded: boolean
  error: string | null
  progress: UpdateProgressInfo | null
  version: string | null
  releaseDate: string | null
  releaseNotes: string | null
}

interface SessionConfig {
  mode: 'single'
  sessionTimeout: number
  maxMessagesPerSession: number
  deleteAfterTimeout: boolean
  maxSessionsPerAccount: number
}

interface SessionRecord {
  id: string
  providerId: string
  accountId: string
  sessionType: 'chat' | 'agent'
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool'
    content: string | any[] | null
    name?: string
    toolCallId?: string
    toolCalls?: Array<{
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }>
    timestamp: number
  }>
  createdAt: number
  lastActiveAt: number
  status: 'active' | 'expired' | 'deleted'
  model?: string
  metadata?: {
    title?: string
    tokenCount?: number
    contextSummary?: string
    summarizedAt?: number
    providerSessionId?: string
  }
}

interface ManagementApiConfig {
  enableManagementApi: boolean
  managementApiSecret: string
  managementApiPort?: number
}

interface ContextManagementConfig {
  enabled: boolean
  strategies: {
    slidingWindow: {
      enabled: boolean
      maxMessages: number
    }
    tokenLimit: {
      enabled: boolean
      maxTokens: number
    }
    summary: {
      enabled: boolean
      keepRecentMessages: number
      summaryPrompt?: string
    }
  }
  executionOrder: ('slidingWindow' | 'tokenLimit' | 'summary')[]
}

type ProviderType = ProviderVendor

export function createClientApi(
  transport: ClientTransport,
  options: ClientApiOptions = {},
): Record<string, any> {
  const isWeb = options.platform === 'web'

  const proxyAPI = {
    start: (port?: number): Promise<boolean> => transport.invoke('proxy:start', port),
    stop: (): Promise<boolean> => transport.invoke('proxy:stop'),
    getStatus: (): Promise<ProxyStatus> => transport.invoke('proxy:getStatus'),
    onStatusChanged: (callback: (status: ProxyStatus) => void) =>
      transport.on('proxy:statusChanged', (status) => callback(status)),
  }

  const storeAPI = {
    get: <T>(key: string): Promise<T | undefined> => transport.invoke('store:get', key),
    set: <T>(key: string, value: T): Promise<void> => transport.invoke('store:set', key, value),
    delete: (key: string): Promise<void> => transport.invoke('store:delete', key),
    clearAll: (): Promise<void> => transport.invoke('store:clearAll'),
    getPath: (): Promise<string> => transport.invoke('store:getPath'),
    onInitError: (callback: (error: { message: string | null }) => void) =>
      transport.on('store:initError', (error) => callback(error)),
    retryInit: (): Promise<{ success: boolean; error?: string }> =>
      transport.invoke('store:retryInit'),
  }

  const outboundProxyAPI = {
    getStatus: (): Promise<OutboundProxyStatus> => transport.invoke('outboundProxy:getStatus'),
    check: (): Promise<OutboundProxyCheckResult> => transport.invoke('outboundProxy:check'),
    enable: (): Promise<OutboundProxyActionResult> => transport.invoke('outboundProxy:enable'),
    disable: (): Promise<{ success: boolean }> => transport.invoke('outboundProxy:disable'),
    getNodes: (): Promise<string[]> => transport.invoke('outboundProxy:getNodes'),
    selectNode: (name: string): Promise<OutboundProxyActionResult> =>
      transport.invoke('outboundProxy:selectNode', name),
  }

  const providersAPI = {
    getAll: (): Promise<Provider[]> => transport.invoke('providers:getAll'),
    getBuiltin: (): Promise<any[]> => transport.invoke('providers:getBuiltin'),
    add: (data: {
      name: string
      authType: AuthType
      apiEndpoint: string
      headers?: Record<string, string>
      description?: string
      supportedModels?: string[]
      credentialFields?: CredentialField[]
    }): Promise<Provider> => transport.invoke('providers:add', data),
    update: (id: string, updates: Partial<Provider>): Promise<Provider | null> =>
      transport.invoke('providers:update', id, updates),
    delete: (id: string): Promise<boolean> => transport.invoke('providers:delete', id),
    checkStatus: (providerId: string): Promise<ProviderCheckResult> =>
      transport.invoke('providers:checkStatus', providerId),
    checkAllStatus: (): Promise<Record<string, ProviderCheckResult>> =>
      transport.invoke('providers:checkAllStatus'),
    duplicate: (id: string): Promise<Provider> => transport.invoke('providers:duplicate', id),
    export: (id: string): Promise<string> => transport.invoke('providers:export', id),
    import: (jsonData: string): Promise<Provider> => transport.invoke('providers:import', jsonData),
    updateModels: (
      providerId: string,
    ): Promise<{
      success: boolean
      modelsCount?: number
      error?: string
    }> => transport.invoke('providers:updateModels', providerId),
    getEffectiveModels: (providerId: string): Promise<EffectiveModel[]> =>
      transport.invoke('providers:getEffectiveModels', providerId),
    addCustomModel: (
      providerId: string,
      model: { displayName: string; actualModelId: string },
    ): Promise<{ success: boolean; models: EffectiveModel[]; error?: string }> =>
      transport.invoke('providers:addCustomModel', providerId, model),
    removeModel: (
      providerId: string,
      modelName: string,
    ): Promise<{ success: boolean; models: EffectiveModel[]; error?: string }> =>
      transport.invoke('providers:removeModel', providerId, modelName),
    resetModels: (
      providerId: string,
    ): Promise<{ success: boolean; models: EffectiveModel[]; error?: string }> =>
      transport.invoke('providers:resetModels', providerId),
  }

  const accountsAPI = {
    getAll: (includeCredentials?: boolean): Promise<Account[]> =>
      transport.invoke('accounts:getAll', includeCredentials),
    getById: (id: string, includeCredentials?: boolean): Promise<Account | null> =>
      transport.invoke('accounts:getById', id, includeCredentials),
    getByProvider: (providerId: string): Promise<Account[]> =>
      transport.invoke('accounts:getByProvider', providerId),
    add: (data: {
      providerId: string
      name: string
      email?: string
      credentials: Record<string, string>
      dailyLimit?: number
    }): Promise<Account> => transport.invoke('accounts:add', data),
    update: (id: string, updates: Partial<Account>): Promise<Account | null> =>
      transport.invoke('accounts:update', id, updates),
    delete: (id: string): Promise<boolean> => transport.invoke('accounts:delete', id),
    validate: (accountId: string): Promise<boolean> =>
      transport.invoke('accounts:validate', accountId),
    validateToken: (
      providerId: string,
      credentials: Record<string, string>,
    ): Promise<{
      valid: boolean
      error?: string
      userInfo?: { name?: string; email?: string; quota?: number; used?: number }
    }> => transport.invoke('accounts:validateToken', providerId, credentials),
    getCredits: (
      accountId: string,
    ): Promise<{
      totalCredits: number
      usedCredits: number
      remainingCredits: number
    } | null> => transport.invoke('accounts:getCredits', accountId),
    clearChats: (accountId: string): Promise<{ success: boolean; error?: string }> =>
      transport.invoke('accounts:clearChats', accountId),
  }

  const oauthAPI = {
    startLogin: (providerId: string, providerType: ProviderType): Promise<OAuthResult> =>
      transport.invoke('oauth:startLogin', providerId, providerType),
    cancelLogin: (): Promise<void> => transport.invoke('oauth:cancelLogin'),
    loginWithToken: (
      providerId: string,
      providerType: ProviderType,
      token: string,
    ): Promise<OAuthResult> =>
      transport.invoke('oauth:loginWithToken', { providerId, providerType, token }),
    validateToken: (
      providerId: string,
      providerType: ProviderType,
      credentials: Record<string, string>,
    ): Promise<TokenValidationResult> =>
      transport.invoke('oauth:validateToken', { providerId, providerType, credentials }),
    refreshToken: (
      providerId: string,
      providerType: ProviderType,
      credentials: Record<string, string>,
    ): Promise<CredentialInfo | null> =>
      transport.invoke('oauth:refreshToken', { providerId, providerType, credentials }),
    getStatus: (): Promise<string> => transport.invoke('oauth:getStatus'),
    startInAppLogin: (
      providerId: string,
      providerType: ProviderType,
      timeout?: number,
    ): Promise<OAuthResult> =>
      transport.invoke('oauth:startInAppLogin', { providerId, providerType, timeout }),
    cancelInAppLogin: (): Promise<void> => transport.invoke('oauth:cancelInAppLogin'),
    isInAppLoginOpen: (): Promise<boolean> => transport.invoke('oauth:inAppLoginStatus'),
    onCallback: (callback: (result: OAuthResult) => void) =>
      transport.on('oauth:callback', (result) => callback(result)),
    onProgress: (callback: (event: OAuthProgressEvent) => void) =>
      transport.on('oauth:progress', (event) => callback(event)),
  }

  const logsAPI = {
    get: (filter?: LogFilter): Promise<LogEntry[]> => transport.invoke('logs:get', filter),
    getStats: (): Promise<LogStats> => transport.invoke('logs:getStats'),
    getTrend: (days?: number): Promise<LogTrend[]> => transport.invoke('logs:getTrend', days),
    getAccountTrend: (accountId: string, days?: number): Promise<LogTrend[]> =>
      transport.invoke('logs:getAccountTrend', accountId, days),
    clear: (): Promise<void> => transport.invoke('logs:clear'),
    export: (format?: 'json' | 'txt'): Promise<string> => transport.invoke('logs:export', format),
    getById: (id: string): Promise<LogEntry | undefined> => transport.invoke('logs:getById', id),
    onNewLog: (callback: (log: LogEntry) => void) =>
      transport.on('logs:newLog', (log) => callback(log)),
  }

  const requestLogsAPI = {
    get: (filter?: RequestLogFilter): Promise<RequestLogEntry[]> =>
      transport.invoke('requestLogs:get', filter),
    getById: (id: string): Promise<RequestLogEntry | undefined> =>
      transport.invoke('requestLogs:getById', id),
    getStats: (): Promise<RequestLogStats> => transport.invoke('requestLogs:getStats'),
    getTrend: (days?: number): Promise<RequestLogTrend[]> =>
      transport.invoke('requestLogs:getTrend', days),
    clear: (): Promise<void> => transport.invoke('requestLogs:clear'),
    onNewLog: (callback: (log: RequestLogEntry) => void) =>
      transport.on('requestLogs:new', (log) => callback(log)),
  }

  const statisticsAPI = {
    get: (): Promise<PersistentStatistics> => transport.invoke('statistics:get'),
    getToday: (): Promise<DailyStatistics> => transport.invoke('statistics:getToday'),
  }

  const appAPI = {
    getVersion: (): Promise<string> => transport.invoke('app:getVersion'),
    minimize: (): Promise<void> => transport.invoke('app:minimize'),
    maximize: (): Promise<void> => transport.invoke('app:maximize'),
    close: (): Promise<void> => transport.invoke('app:close'),
    showWindow: (): Promise<void> => transport.invoke('app:showWindow'),
    hideWindow: (): Promise<void> => transport.invoke('app:hideWindow'),
    openExternal: (url: string): Promise<void> => {
      if (isWeb && typeof window !== 'undefined') {
        window.open(url, '_blank', 'noopener,noreferrer')
        return Promise.resolve()
      }
      return transport.invoke('app:openExternal', url)
    },
    checkUpdate: (): Promise<UpdateStatus> => transport.invoke('app:checkUpdate'),
    downloadUpdate: (): Promise<void> => transport.invoke('app:downloadUpdate'),
    installUpdate: (): Promise<void> => transport.invoke('app:installUpdate'),
    getUpdateStatus: (): Promise<UpdateStatus> => transport.invoke('app:getUpdateStatus'),
    onUpdateChecking: (callback: () => void) =>
      transport.on('app:updateChecking', () => callback()),
    onUpdateAvailable: (callback: (info: any) => void) =>
      transport.on('app:updateAvailable', (info) => callback(info)),
    onUpdateNotAvailable: (callback: (info: any) => void) =>
      transport.on('app:updateNotAvailable', (info) => callback(info)),
    onUpdateProgress: (callback: (progress: UpdateProgressInfo) => void) =>
      transport.on('app:updateProgress', (progress) => callback(progress)),
    onUpdateDownloaded: (callback: (info: any) => void) =>
      transport.on('app:updateDownloaded', (info) => callback(info)),
    onUpdateError: (callback: (error: { message?: string } | string) => void) =>
      transport.on('app:updateError', (error) => callback(error)),
  }

  const configAPI = {
    get: (): Promise<AppConfig> => transport.invoke('config:get'),
    update: (updates: Partial<AppConfig>): Promise<boolean> =>
      transport.invoke('config:update', updates),
    onConfigChanged: (callback: (config: AppConfig) => void) =>
      transport.on('config:changed', (config) => callback(config)),
  }

  const promptsAPI = {
    getAll: (): Promise<SystemPrompt[]> => transport.invoke('prompts:getAll'),
    getBuiltin: (): Promise<SystemPrompt[]> => transport.invoke('prompts:getBuiltin'),
    getCustom: (): Promise<SystemPrompt[]> => transport.invoke('prompts:getCustom'),
    getById: (id: string): Promise<SystemPrompt | undefined> =>
      transport.invoke('prompts:getById', id),
    add: (prompt: Omit<SystemPrompt, 'id' | 'createdAt' | 'updatedAt'>): Promise<SystemPrompt> =>
      transport.invoke('prompts:add', prompt),
    update: (id: string, updates: Partial<SystemPrompt>): Promise<SystemPrompt | null> =>
      transport.invoke('prompts:update', id, updates),
    delete: (id: string): Promise<boolean> => transport.invoke('prompts:delete', id),
    getByType: (type: PromptType): Promise<SystemPrompt[]> =>
      transport.invoke('prompts:getByType', type),
  }

  const sessionAPI = {
    getConfig: (): Promise<SessionConfig> => transport.invoke('session:getConfig'),
    updateConfig: (config: Partial<SessionConfig>): Promise<void> =>
      transport.invoke('session:updateConfig', config),
    getAll: (): Promise<SessionRecord[]> => transport.invoke('session:getAll'),
    getActive: (): Promise<SessionRecord[]> => transport.invoke('session:getActive'),
    getById: (id: string): Promise<SessionRecord | undefined> =>
      transport.invoke('session:getById', id),
    getByAccount: (accountId: string): Promise<SessionRecord[]> =>
      transport.invoke('session:getByAccount', accountId),
    getByProvider: (providerId: string): Promise<SessionRecord[]> =>
      transport.invoke('session:getByProvider', providerId),
    delete: (id: string): Promise<boolean> => transport.invoke('session:delete', id),
    clearAll: (): Promise<void> => transport.invoke('session:clearAll'),
    cleanExpired: (): Promise<number> => transport.invoke('session:cleanExpired'),
  }

  const managementApiAPI = {
    getConfig: (): Promise<ManagementApiConfig> => transport.invoke('managementApi:getConfig'),
    updateConfig: (updates: Partial<ManagementApiConfig>): Promise<ManagementApiConfig> =>
      transport.invoke('managementApi:updateConfig', updates),
    generateSecret: (): Promise<string> => transport.invoke('managementApi:generateSecret'),
  }

  const contextManagementAPI = {
    getConfig: (): Promise<ContextManagementConfig> =>
      transport.invoke('contextManagement:getConfig'),
    updateConfig: (updates: Partial<ContextManagementConfig>): Promise<ContextManagementConfig> =>
      transport.invoke('contextManagement:updateConfig', updates),
  }

  function resolveManagementApiBaseUrl(config: AppConfig): string {
    if (isWeb) {
      return options.managementBaseUrl || '/v0/management'
    }
    const configuredHost = config.proxyHost || '127.0.0.1'
    const host =
      configuredHost === '0.0.0.0' || configuredHost === '::' || configuredHost === '[::]'
        ? '127.0.0.1'
        : configuredHost
    return `http://${host}:${config.proxyPort}/v0/management`
  }

  const toolCallingAPI = {
    async getStatus() {
      const config = await configAPI.get()
      const secret = config.managementApi?.managementApiSecret
      const headers: Record<string, string> = secret ? { Authorization: `Bearer ${secret}` } : {}
      if (isWeb) {
        const response = await fetch(`${resolveManagementApiBaseUrl(config)}/tool-calling/status`, {
          headers,
        })
        return response.json()
      }
      if (!secret) return null
      const response = await fetch(`${resolveManagementApiBaseUrl(config)}/tool-calling/status`, {
        headers,
      })
      return response.json()
    },

    async runSmoke(input: { clientAdapterId: string }) {
      const config = await configAPI.get()
      const secret = config.managementApi?.managementApiSecret
      if (!isWeb && !secret) {
        return { success: false, error: { message: 'Management API secret is not configured.' } }
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (secret) {
        headers.Authorization = `Bearer ${secret}`
      }
      const response = await fetch(`${resolveManagementApiBaseUrl(config)}/tool-calling/smoke`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      })
      return response.json()
    },
  }

  const trayAPI = {
    openDashboard: (): void => transport.send('tray:open-dashboard'),
    setHeight: (height: number): void => transport.send('tray:set-height', height),
    quitApp: (): void => transport.send('tray:quit-app'),
  }

  return {
    platform: options.platform || 'electron',
    proxy: proxyAPI,
    outboundProxy: outboundProxyAPI,
    store: storeAPI,
    providers: providersAPI,
    accounts: accountsAPI,
    oauth: oauthAPI,
    logs: logsAPI,
    requestLogs: requestLogsAPI,
    statistics: statisticsAPI,
    app: appAPI,
    config: configAPI,
    prompts: promptsAPI,
    session: sessionAPI,
    managementApi: managementApiAPI,
    contextManagement: contextManagementAPI,
    toolCalling: toolCallingAPI,
    tray: trayAPI,

    on: (channel: string, callback: (...args: unknown[]) => void) =>
      transport.on(channel, (...args) => callback(...args)),

    send: (channel: string, ...args: unknown[]) => {
      transport.send(channel, ...args)
    },

    invoke: (channel: string, ...args: unknown[]) => transport.invoke(channel, ...args),
  }
}
