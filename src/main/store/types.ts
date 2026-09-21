/**
 * Credential Storage Module - Type Definitions
 * Defines core data structures for accounts, providers, and configuration
 *
 * Canonical domain types (Account, Provider, AppConfig, ...) live in
 * `src/shared/types.ts` and are re-exported here so both the main process and
 * the renderer share a single definition. Store-specific types remain below.
 */

import type { LegacyToolPromptConfig, ToolCallingConfig } from '../../shared/toolCalling.ts'
import { DEFAULT_TOOL_CALLING_CONFIG } from '../../shared/toolCalling.ts'
import type {
  Account,
  AppConfig,
  ContextManagementConfig,
  LogEntry,
  ManagementApiConfig,
  ModelMapping,
  Provider,
  RequestLogConfig,
  SessionConfig,
  SystemPrompt,
} from '../../shared/types'

export type {
  Account,
  AccountStatus,
  ApiKey,
  AppConfig,
  AuthType,
  ContextManagementConfig,
  CredentialField,
  EffectiveModel,
  LoadBalanceStrategy,
  LogEntry,
  LogLevel,
  ManagementApiConfig,
  ModelMapping,
  OutboundProxySettings,
  PromptType,
  Provider,
  ProviderStatus,
  ProviderType,
  RequestLogConfig,
  SessionConfig,
  SlidingWindowConfig,
  SummaryConfig,
  SystemPrompt,
  Theme,
  TokenLimitConfig,
  ValidationResult,
} from '../../shared/types'

export type { LegacyToolPromptConfig, ToolCallingConfig }

/**
 * Built-in Provider Configuration Interface
 *
 * Defined alongside the provider plugin contracts (`providers/types.ts`) and
 * re-exported here for backwards compatibility with existing store imports.
 */
export type { BuiltinProviderConfig } from '../providers/types.ts'

/**
 * Session Status Enum
 */
export type SessionStatus = 'active' | 'expired' | 'deleted'

/**
 * Chat Message Interface
 * Represents a single message in a conversation
 */
export interface ChatMessage {
  /** Message role */
  role: 'user' | 'assistant' | 'system' | 'tool'
  /** Message content */
  content: string | any[] | null
  /** Optional participant name from the OpenAI message format */
  name?: string
  /** Timestamp */
  timestamp: number
  /** Provider-specific message ID */
  providerMessageId?: string
  /** Tool call ID (for tool messages) */
  toolCallId?: string
  /** Native OpenAI function calls emitted by an assistant message */
  toolCalls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: string
    }
  }>
}

/**
 * Session Record Interface
 * Represents a conversation session
 */
export interface SessionRecord {
  /** Session unique identifier */
  id: string
  /** Provider ID */
  providerId: string
  /** Account ID */
  accountId: string
  /** Session type */
  sessionType: 'chat' | 'agent'
  /** Message history */
  messages: ChatMessage[]
  /** Creation time (timestamp) */
  createdAt: number
  /** Last active time (timestamp) */
  lastActiveAt: number
  /** Session status */
  status: SessionStatus
  /** Model used */
  model?: string
  /** Session metadata */
  metadata?: {
    title?: string
    tokenCount?: number
    /** Latest generated summary, duplicated for management UI visibility. */
    contextSummary?: string
    summarizedAt?: number
    /** Last provider-side conversation identifier, when one is available. */
    providerSessionId?: string
  }
}

/**
 * Request Log Entry Interface
 * Detailed log for API request tracking
 */
export interface RequestLogEntry {
  /** Log ID */
  id: string
  /** Timestamp */
  timestamp: number
  /** Request status */
  status: 'success' | 'error'
  /** HTTP status code */
  statusCode: number

  /** Source IP of the client that called this proxy endpoint (already sanitized) */
  clientIp?: string

  /** Outbound exit used for the upstream call (Clash node name / exit IP); empty = direct */
  egressNode?: string

  /** API key label used by the caller: local key-list name when matched, else the raw key */
  apiKey?: string

  /** HTTP method */
  method: string
  /** Request URL path */
  url: string
  /** Requested model name */
  model: string
  /** Actual model used (after mapping) */
  actualModel?: string

  /** Provider ID */
  providerId?: string
  /** Provider name */
  providerName?: string
  /** Account ID */
  accountId?: string
  /** Account name */
  accountName?: string

  /** Request body JSON string */
  requestBody?: string
  /** User input extracted from messages (truncated to 200 chars) */
  userInput?: string

  /** Web search enabled */
  webSearch?: boolean
  /** Reasoning effort level */
  reasoningEffort?: string | boolean

  /** Bounded tool-repair observability (structural metadata only). */
  repair_attempted?: boolean
  repair_attempts?: number
  repair_result?: 'not_attempted' | 'succeeded' | 'failed'
  first_validation_error?: string
  final_validation_error?: string
  first_field_types?: Array<{
    json_pointer: string
    expected: string
    actual_type: string
    keyword: string
  }>
  final_field_types?: Array<{
    json_pointer: string
    expected: string
    actual_type: string
    keyword: string
  }>

  /** Response status code */
  responseStatus: number
  /** Response preview (truncated) */
  responsePreview?: string
  /** Response body JSON string */
  responseBody?: string

  /** Request latency in milliseconds */
  latency: number
  /** Whether streaming request */
  isStream: boolean

  /** Error message */
  errorMessage?: string
  /** Error stack trace */
  errorStack?: string
}

/**
 * Per-dimension request counts for a single day, split by outcome.
 */
export interface DailyUsageBucket {
  total: number
  success: number
  failed: number
}

/**
 * Daily Statistics Interface
 * Statistics for a single day
 */
export interface DailyStatistics {
  /** Date string (YYYY-MM-DD) */
  date: string
  /** Total requests */
  totalRequests: number
  /** Successful requests */
  successRequests: number
  /** Failed requests */
  failedRequests: number
  /** Total latency (for average calculation) */
  totalLatency: number
  /**
   * Snapshot of the active (enabled, status `active`) account count observed
   * during this day. Used for the dashboard "vs yesterday" comparison.
   */
  activeAccounts?: number
  /** Per-model request counts (outcome split) */
  modelStats?: Record<string, DailyUsageBucket>
  /** Per-API-key-label request counts (outcome split) */
  apiKeyStats?: Record<string, DailyUsageBucket>
  /** Model usage count */
  modelUsage: Record<string, number>
  /** Provider usage count */
  providerUsage: Record<string, number>
}

/**
 * Persistent Statistics Interface
 * Statistics that persist across app restarts
 */
export interface PersistentStatistics {
  /** Total requests (all time) */
  totalRequests: number
  /** Successful requests (all time) */
  successRequests: number
  /** Failed requests (all time) */
  failedRequests: number
  /** Total latency for average calculation */
  totalLatency: number
  /** Last updated timestamp */
  lastUpdated: number
  /** Model usage count */
  modelUsage: Record<string, number>
  /** Provider usage count */
  providerUsage: Record<string, number>
  /** Account usage count */
  accountUsage: Record<string, number>
  /** Daily statistics (keyed by date string) */
  dailyStats: Record<string, DailyStatistics>
}

/**
 * Custom Model Configuration
 * User-defined model with display name and actual API model ID
 */
export interface CustomModel {
  /** Model display name (used in AI client) */
  displayName: string
  /** Actual model ID (used in API call) */
  actualModelId: string
}

/**
 * User Model Overrides for a Provider
 * Stores user customizations to built-in provider models
 */
export interface ProviderModelOverrides {
  /** User added custom models */
  addedModels: CustomModel[]
  /** Excluded default model display names */
  excludedModels: string[]
}

/**
 * User Model Overrides
 * Maps provider IDs to their model customizations
 */
export type UserModelOverrides = Record<string, ProviderModelOverrides>

export const DEEPSEEK_PRIMARY_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro']

export const DEEPSEEK_LEGACY_MODEL_MAPPING_NAMES = [
  'deepseek-chat',
  'deepseek-reasoner',
  'DeepSeek-V3.2',
  'DeepSeek-Search',
  'DeepSeek-R1',
  'DeepSeek-R1-Search',
]

/**
 * Storage Data Structure Interface
 */
export interface StoreSchema {
  /** Provider list */
  providers: Provider[]
  /** Account list */
  accounts: Account[]
  /** Application configuration */
  config: AppConfig
  /** Log entries */
  logs: LogEntry[]
  /** Request log entries */
  requestLogs: RequestLogEntry[]
  /** System prompts */
  systemPrompts: SystemPrompt[]
  /** Session records */
  sessions: SessionRecord[]
  /** Persistent statistics */
  statistics: PersistentStatistics
  /** User model overrides for built-in providers */
  userModelOverrides: UserModelOverrides
}

/**
 * Default Session Configuration
 */
export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  sessionTimeout: 30,
  maxMessagesPerSession: 50,
  deleteAfterTimeout: false,
  maxSessionsPerAccount: 3,
}

/**
 * Default Persistent Statistics
 */
export const DEFAULT_STATISTICS: PersistentStatistics = {
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  totalLatency: 0,
  lastUpdated: Date.now(),
  modelUsage: {},
  providerUsage: {},
  accountUsage: {},
  dailyStats: {},
}

/**
 * Default User Model Overrides
 */
export const DEFAULT_USER_MODEL_OVERRIDES: UserModelOverrides = {}

export const DEFAULT_TOOL_CALLING_CONFIG_VALUE = DEFAULT_TOOL_CALLING_CONFIG

/**
 * Default Management API Configuration
 */
export const DEFAULT_MANAGEMENT_API_CONFIG: ManagementApiConfig = {
  enableManagementApi: false,
  managementApiSecret: '',
}

/**
 * Default Context Management Configuration
 */
export const DEFAULT_CONTEXT_MANAGEMENT_CONFIG: ContextManagementConfig = {
  enabled: false,
  strategies: {
    slidingWindow: { enabled: true, maxMessages: 20 },
    tokenLimit: { enabled: false, maxTokens: 4000 },
    summary: { enabled: false, keepRecentMessages: 20 },
  },
  executionOrder: ['summary', 'slidingWindow', 'tokenLimit'],
}

export const DEFAULT_REQUEST_LOG_CONFIG: RequestLogConfig = {
  enabled: true,
  maxEntries: 200,
  includeBodies: false,
  maxBodyChars: 8000,
  redactSensitiveData: true,
}

export const DEFAULT_DEEPSEEK_MODEL_MAPPINGS: Record<string, ModelMapping> = {
  'deepseek-v4-flash-think': {
    requestModel: 'deepseek-v4-flash-think',
    actualModel: 'deepseek-v4-flash',
    preferredProviderId: 'deepseek',
  },
  'deepseek-v4-flash-search': {
    requestModel: 'deepseek-v4-flash-search',
    actualModel: 'deepseek-v4-flash',
    preferredProviderId: 'deepseek',
  },
  'deepseek-v4-flash-think-search': {
    requestModel: 'deepseek-v4-flash-think-search',
    actualModel: 'deepseek-v4-flash',
    preferredProviderId: 'deepseek',
  },
  'deepseek-v4-pro-think': {
    requestModel: 'deepseek-v4-pro-think',
    actualModel: 'deepseek-v4-pro',
    preferredProviderId: 'deepseek',
  },
  'deepseek-v4-pro-search': {
    requestModel: 'deepseek-v4-pro-search',
    actualModel: 'deepseek-v4-pro',
    preferredProviderId: 'deepseek',
  },
  'deepseek-v4-pro-think-search': {
    requestModel: 'deepseek-v4-pro-think-search',
    actualModel: 'deepseek-v4-pro',
    preferredProviderId: 'deepseek',
  },
}

export function createDefaultModelMappings(): Record<string, ModelMapping> {
  return Object.fromEntries(
    Object.entries(DEFAULT_DEEPSEEK_MODEL_MAPPINGS).map(([key, mapping]) => [key, { ...mapping }]),
  )
}

export function isDefaultModelMapping(requestModel: string): boolean {
  return requestModel in DEFAULT_DEEPSEEK_MODEL_MAPPINGS
}

export function normalizeModelMappingsWithDefaults(
  mappings?: Record<string, ModelMapping>,
): Record<string, ModelMapping> {
  const legacyModelNames = new Set(DEEPSEEK_LEGACY_MODEL_MAPPING_NAMES)
  const customMappings = Object.fromEntries(
    Object.entries(mappings || {}).filter(
      ([requestModel]) =>
        !isDefaultModelMapping(requestModel) && !legacyModelNames.has(requestModel),
    ),
  )

  return {
    ...createDefaultModelMappings(),
    ...customMappings,
  }
}

export function sanitizeDeepSeekModelOverrides(
  overrides?: ProviderModelOverrides,
): ProviderModelOverrides {
  const migratedModelNames = new Set([
    ...DEEPSEEK_PRIMARY_MODELS,
    ...DEEPSEEK_LEGACY_MODEL_MAPPING_NAMES,
    ...Object.keys(DEFAULT_DEEPSEEK_MODEL_MAPPINGS),
  ])

  return {
    addedModels: (overrides?.addedModels || []).filter(
      (model) => !migratedModelNames.has(model.displayName),
    ),
    excludedModels: (overrides?.excludedModels || []).filter((model) =>
      DEEPSEEK_PRIMARY_MODELS.includes(model),
    ),
  }
}

/**
 * Default Application Configuration
 */
export const DEFAULT_CONFIG: AppConfig = {
  proxyPort: 8080,
  proxyHost: '127.0.0.1',
  trustedProxyHops: 0,
  loadBalanceStrategy: 'round-robin',
  modelMappings: createDefaultModelMappings(),
  defaultModelMappingsSeeded: true,
  theme: 'system',
  autoStart: false,
  autoStartProxy: false,
  minimizeToTray: true,
  logLevel: 'info',
  logRetentionDays: 7,
  requestLogConfig: DEFAULT_REQUEST_LOG_CONFIG,
  requestTimeout: 60000,
  retryCount: 3,
  apiKeys: [],
  enableApiKey: false,
  oauthProxyMode: 'system',
  registrationApi: {
    enabled: false,
    baseUrl: 'https://xbsms.work',
    token: '',
    authMode: 'query',
    keyWord: '',
    province: '全部',
    cardType: '全部',
    codeSource: 'getMsg',
    autoRelease: true,
    minRequestIntervalMs: 1500,
    codePollIntervalMs: 1500,
    codePollTimeoutMs: 180000,
  },
  sessionConfig: DEFAULT_SESSION_CONFIG,
  toolCallingConfig: DEFAULT_TOOL_CALLING_CONFIG,
  toolPromptConfig: undefined,
  managementApi: DEFAULT_MANAGEMENT_API_CONFIG,
  contextManagement: DEFAULT_CONTEXT_MANAGEMENT_CONFIG,
  language: 'zh-CN',
  outboundProxy: {
    enabled: false,
    groupAssignmentEnabled: false,
    activeSourceId: '',
    rotation: {
      strategy: 'roundRobin',
      rotateEarlySeconds: 30,
      verifyBeforeUse: true,
      verifyTimeoutMs: 2000,
      maxExitAttempts: 0,
      rotateAfterFailures: 2,
      rotateMinIntervalMs: 3000,
      cooldownBaseMs: 1000,
      cooldownMaxMs: 30000,
    },
    sources: [],
    groups: [],
  },
}

/**
 * Built-in Provider Configuration
 * Re-exported from providers/builtin/index.ts to avoid duplication
 */
export { builtinProviders as BUILTIN_PROVIDERS } from '../providers/builtin/index.ts'
