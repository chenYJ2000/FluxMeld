export type AccountStatus = 'active' | 'inactive' | 'expired' | 'error'

export type ProviderStatus = 'online' | 'offline' | 'unknown'

export type ProviderType = 'builtin' | 'custom'

// Provider vendor type (for OAuth adapters)
export type ProviderVendor =
  | 'deepseek'
  | 'glm'
  | 'kimi'
  | 'mimo'
  | 'minimax'
  | 'qwen'
  | 'qwen-ai'
  | 'zai'
  | 'perplexity'
  | 'custom'

export type AuthType =
  | 'oauth'
  | 'token'
  | 'cookie'
  | 'userToken'
  | 'refresh_token'
  | 'jwt'
  | 'realUserID_token'
  | 'tongyi_sso_ticket'

export interface CredentialField {
  name: string
  label: string
  type: 'text' | 'password' | 'textarea'
  required: boolean
  placeholder?: string
  helpText?: string
  /** Optional i18n keys so the renderer can localize without provider-specific branches */
  labelKey?: string
  placeholderKey?: string
  helpTextKey?: string
}

/** Serializable capability flags a provider may expose to the UI. */
export interface ProviderCapabilities {
  /** Account-level "delete all chats" support */
  clearChats?: boolean
  /** Provider usage credits support */
  credits?: boolean
  /** Whether FluxMeld provides managed (prompt-emulated) tool calling for this provider */
  toolCalling?: boolean
}

/** Serializable UI metadata for a provider. */
export interface ProviderUiMeta {
  /** Asset key under `renderer/src/assets/providers/<iconKey>.svg` */
  iconKey?: string
  /** i18n namespace prefix for provider-specific strings */
  i18nPrefix?: string
  /** Optional i18n key for a provider-specific notice shown in the card */
  noticeKey?: string
}

export type LoadBalanceStrategy =
  'round-robin' | 'fill-first' | 'failover' | 'least-recently-used' | 'balanced'

export type Theme = 'light' | 'dark' | 'system'

/** Controls message count-based context trimming */
export interface SlidingWindowConfig {
  enabled: boolean
  maxMessages: number
}

/** Controls token count-based context trimming */
export interface TokenLimitConfig {
  enabled: boolean
  maxTokens: number
}

/** Controls context summarization strategy */
export interface SummaryConfig {
  enabled: boolean
  keepRecentMessages: number
  summaryPrompt?: string
}

/** Controls how conversation context is managed and trimmed */
export interface ContextManagementConfig {
  enabled: boolean
  strategies: {
    slidingWindow: SlidingWindowConfig
    tokenLimit: TokenLimitConfig
    summary: SummaryConfig
  }
  executionOrder: ('slidingWindow' | 'tokenLimit' | 'summary')[]
}

/** Rotation policy applied by the outbound proxy manager. */
export interface RotationPolicy {
  strategy: 'roundRobin' | 'lowestLatency' | 'random'
  /** Auto-rotate this many seconds before an exit expires (0 disables). */
  rotateEarlySeconds: number
  /** Verify an exit before routing traffic through it. */
  verifyBeforeUse: boolean
  /** Timeout for a single exit connectivity verification (ms). */
  verifyTimeoutMs: number
  /** Max candidate exits tried per activation/rotation. */
  maxExitAttempts: number
  /** Minimum interval between two rotations (ms). */
  rotateMinIntervalMs: number
  /** First cooldown after an activation failure (ms). */
  cooldownBaseMs: number
  /** Upper bound of the exponential activation-failure cooldown (ms). */
  cooldownMaxMs: number
}

/** Persisted settings for one configured outbound proxy source instance. */
export interface EgressSourceConfig {
  id: string
  sourceId: string
  settings: Record<string, unknown>
}

/** A named proxy group. Groups are global; the same group across providers
 * shares one dynamically assigned exit. */
export interface ProxyGroup {
  id: string
  name: string
}

/** Outbound proxy settings (sources, rotation, per-account grouping). */
export interface OutboundProxySettings {
  /** Master switch, default off. */
  enabled: boolean
  /**
   * When false, all accounts route through the single active proxy exit.
   * When true, accounts are routed by their assigned group (direct group stays
   * strictly direct). Default false.
   */
  groupAssignmentEnabled: boolean
  /** Active egress source config id. */
  activeSourceId: string
  rotation: RotationPolicy
  sources: EgressSourceConfig[]
  /** Global proxy group definitions. */
  groups: ProxyGroup[]
}

import type { LegacyToolPromptConfig, ToolCallingConfig } from './toolCalling'

export type { LegacyToolPromptConfig, ToolCallingConfig } from './toolCalling'

export interface Account {
  id: string
  providerId: string
  name: string
  email?: string
  credentials: Record<string, string>
  status: AccountStatus
  /**
   * Manual per-account switch, independent of health status. When false the
   * account is never selected for forwarding. Undefined is treated as enabled
   * for backward compatibility.
   */
  enabled?: boolean
  lastUsed?: number
  createdAt: number
  updatedAt: number
  errorMessage?: string
  /** Last credential/health check time */
  lastStatusCheck?: number
  requestCount?: number
  dailyLimit?: number
  todayUsed?: number
}

export interface Provider {
  id: string
  name: string
  type: ProviderType
  authType: AuthType
  apiEndpoint: string
  chatPath?: string
  headers: Record<string, string>
  enabled: boolean
  createdAt: number
  updatedAt: number
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
  status?: ProviderStatus
  lastStatusCheck?: number
  /** Credential field configuration (present on built-in providers) */
  credentialFields?: CredentialField[]
  /** Serializable capability flags surfaced to the UI */
  capabilities?: ProviderCapabilities
  /** Serializable UI metadata (icon key, i18n prefix, notices) */
  ui?: ProviderUiMeta
  /**
   * Per-account outbound proxy grouping. Maps accountId to a proxy group id, or
   * null for the direct (strict direct) group. When the whole map is absent the
   * provider falls back to the global outbound-proxy behaviour.
   */
  proxyAssignment?: Record<string, string | null>
}

export interface ModelMapping {
  requestModel: string
  actualModel: string
  preferredProviderId?: string
  preferredAccountId?: string
}

export interface ApiKey {
  id: string
  name: string
  key: string
  enabled: boolean
  createdAt: number
  lastUsedAt?: number
  usageCount: number
  description?: string
}

export interface AppConfig {
  proxyPort: number
  proxyHost: string
  /**
   * Number of trusted reverse proxies (nginx/frp, remote to FluxMeld) in front
   * of this instance whose X-Forwarded-For entries may be skipped when resolving
   * the client source IP. 0 = auto walk from the right skipping loopback hops.
   */
  trustedProxyHops: number
  loadBalanceStrategy: LoadBalanceStrategy
  modelMappings: Record<string, ModelMapping>
  /** Default model mappings have been seeded into editable config */
  defaultModelMappingsSeeded?: boolean
  theme: Theme
  autoStart: boolean
  autoStartProxy: boolean
  minimizeToTray: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  logRetentionDays: number
  requestLogConfig: RequestLogConfig
  requestTimeout: number
  retryCount: number
  apiKeys: ApiKey[]
  enableApiKey: boolean
  oauthProxyMode: 'system' | 'none'
  sessionConfig: SessionConfig
  toolCallingConfig: ToolCallingConfig
  toolPromptConfig?: LegacyToolPromptConfig
  managementApi: ManagementApiConfig
  contextManagement?: ContextManagementConfig
  language: 'zh-CN' | 'en-US'
  outboundProxy: OutboundProxySettings
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: string
  timestamp: number
  level: LogLevel
  message: string
  accountId?: string
  providerId?: string
  requestId?: string
  data?: Record<string, unknown>
}

export interface ProxyStatus {
  isRunning: boolean
  port: number
  host: string
  uptime: number
  connections: number
}

export interface ProxyStatistics {
  totalRequests: number
  successRequests: number
  failedRequests: number
  avgLatency: number
  requestsPerMinute: number
  activeConnections: number
  modelUsage: Record<string, number>
  providerUsage: Record<string, number>
  accountUsage: Record<string, number>
}

export interface ProviderCheckResult {
  providerId: string
  status: ProviderStatus
  latency?: number
  error?: string
}

export interface OAuthResult {
  success: boolean
  providerId?: string
  providerType?: ProviderVendor
  credentials?: Record<string, string>
  account?: Account
  accountInfo?: {
    userId?: string
    email?: string
    name?: string
  }
  error?: string
}

export interface ValidationResult {
  valid: boolean
  error?: string
  validatedAt: number
  accountInfo?: {
    name?: string
    email?: string
    quota?: number
    used?: number
    expiresAt?: number
  }
}

export type PromptType = 'general' | 'tool-use' | 'agent' | 'translation' | 'search'

export interface SystemPrompt {
  id: string
  name: string
  description: string
  prompt: string
  type: PromptType
  isBuiltin: boolean
  emoji?: string
  groups?: string[]
  createdAt: number
  updatedAt: number
}

export interface SessionConfig {
  sessionTimeout: number
  maxMessagesPerSession: number
  deleteAfterTimeout: boolean
  maxSessionsPerAccount: number
}

export interface RequestLogConfig {
  enabled: boolean
  maxEntries: number
  includeBodies: boolean
  maxBodyChars: number
  redactSensitiveData: boolean
}

export interface ManagementApiConfig {
  enableManagementApi: boolean
  managementApiSecret: string
  managementApiPort?: number
}

export interface ManagementApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: ManagementApiError
}

export interface ManagementApiError {
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface ManagementApiPaginationParams {
  page?: number
  limit?: number
}

export interface ManagementApiPaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface CreateProviderRequest {
  name: string
  type: ProviderType
  authType: AuthType
  apiEndpoint: string
  chatPath?: string
  headers?: Record<string, string>
  enabled?: boolean
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
}

export interface UpdateProviderRequest {
  name?: string
  apiEndpoint?: string
  chatPath?: string
  headers?: Record<string, string>
  enabled?: boolean
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
}

export interface ProviderStatusRequest {
  enabled: boolean
}

export interface CreateAccountRequest {
  providerId: string
  name: string
  email?: string
  credentials: Record<string, string>
  dailyLimit?: number
}

export interface UpdateAccountRequest {
  name?: string
  email?: string
  credentials?: Record<string, string>
  dailyLimit?: number
}

export interface BatchCreateAccountsRequest {
  accounts: CreateAccountRequest[]
}

export interface BatchUpdateAccountItem extends UpdateAccountRequest {
  id: string
  status?: AccountStatus
}

export interface BatchUpdateAccountsRequest {
  updates: BatchUpdateAccountItem[]
}

export interface BatchDeleteAccountsRequest {
  ids?: string[]
  /** When set, every account of this provider is deleted. */
  providerId?: string
}

export interface AccountQueryRequest {
  ids?: string[]
  providerId?: string
  status?: AccountStatus
  /** Case-insensitive substring match on the account name. */
  name?: string
  /** Case-insensitive substring match on the account email. */
  email?: string
  /** When true, returns plaintext credentials instead of masked values. */
  includeCredentials?: boolean
}

export interface BatchAccountResult {
  index: number
  success: boolean
  account?: Account
  id?: string
  error?: ManagementApiError
}

export interface BatchAccountsResponse {
  total: number
  succeeded: number
  failed: number
  results: BatchAccountResult[]
}

export interface BatchDeleteAccountsResponse extends BatchAccountsResponse {
  deletedCount: number
}

export interface AccountsQueryResponse {
  total: number
  items: Account[]
}

/** Per-entry failure detail for account import. */
export interface AccountImportError {
  index: number
  name?: string
  providerId?: string
  code: string
  message: string
}

/** Summary returned by account import; duplicates are counted as skipped. */
export interface AccountImportResult {
  total: number
  succeeded: number
  skipped: number
  failed: number
  errors: AccountImportError[]
}

export interface CreateApiKeyRequest {
  name: string
  description?: string
}

export interface UpdateApiKeyRequest {
  name?: string
  description?: string
  enabled?: boolean
}

export interface CreateModelMappingRequest {
  requestModel: string
  actualModel: string
  preferredProviderId?: string
  preferredAccountId?: string
}

export interface UpdateModelMappingRequest {
  actualModel?: string
  preferredProviderId?: string
  preferredAccountId?: string
}

export interface ProxyStatusResponse {
  isRunning: boolean
  port: number
  host: string
  uptime: number
  connections: number
}

export interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy' | 'degraded'
  version: string
  uptime: number
  timestamp: number
  components?: {
    proxy: 'up' | 'down'
    database: 'up' | 'down'
    managementApi: 'up' | 'down'
  }
}

export interface StatisticsResponse {
  totalRequests: number
  successRequests: number
  failedRequests: number
  avgLatency: number
  requestsPerMinute: number
  activeConnections: number
  modelUsage: Record<string, number>
  providerUsage: Record<string, number>
  accountUsage: Record<string, number>
  dailyStats?: Record<
    string,
    {
      totalRequests: number
      successRequests: number
      failedRequests: number
    }
  >
}

export interface ConfigUpdateRequest {
  proxyPort?: number
  proxyHost?: string
  loadBalanceStrategy?: LoadBalanceStrategy
  theme?: Theme
  autoStart?: boolean
  autoStartProxy?: boolean
  minimizeToTray?: boolean
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  logRetentionDays?: number
  requestLogConfig?: Partial<RequestLogConfig>
  requestTimeout?: number
  retryCount?: number
  enableApiKey?: boolean
  oauthProxyMode?: 'system' | 'none'
  sessionConfig?: SessionConfig
  toolCallingConfig?: Partial<ToolCallingConfig>
  toolPromptConfig?: LegacyToolPromptConfig
  managementApi?: ManagementApiConfig
}

export interface EffectiveModel {
  displayName: string
  actualModelId: string
  isCustom: boolean
}
