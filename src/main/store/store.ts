/**
 * Credential Storage Module - Core Storage Implementation
 * Uses electron-store for persistent storage.
 * Data is stored as plaintext so the desktop app and the headless web server
 * can share the same data.json (see FLUXMELD_DATA_DIR).
 */

import type { BrowserWindow } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import {
  StoreSchema,
  AppConfig,
  Account,
  Provider,
  LogEntry,
  DEFAULT_CONFIG,
  BUILTIN_PROVIDERS,
  LogLevel,
  SystemPrompt,
  SessionRecord,
  SessionConfig,
  DEFAULT_SESSION_CONFIG,
  ChatMessage,
  RequestLogEntry,
  RequestLogConfig,
  PersistentStatistics,
  DailyStatistics,
  DailyUsageBucket,
  DEFAULT_STATISTICS,
  EffectiveModel,
  ProviderModelOverrides,
  DEFAULT_USER_MODEL_OVERRIDES,
  UserModelOverrides,
  CustomModel,
  DEFAULT_REQUEST_LOG_CONFIG,
  ContextManagementConfig,
  DEFAULT_CONTEXT_MANAGEMENT_CONFIG,
  createDefaultModelMappings,
  normalizeModelMappingsWithDefaults,
  sanitizeDeepSeekModelOverrides,
} from './types'
import { BUILTIN_PROMPTS } from '../data/builtin-prompts'
import { RequestLogManager } from '../requestLogs/manager'
import { normalizeRequestLogConfig } from '../requestLogs/types'
import type { RequestLogFilter, RequestLogFilterOptions } from '../requestLogs/types'
import { normalizeToolCallingConfig } from '../../shared/toolCalling'
import { localDateKey, localDateKeyOffset } from '../../shared/date'
import { AppLogManager } from '../appLogs/manager'
import type { AppLogFilter } from '../appLogs/types'

// Dynamically import electron-store (ESM module)
let Store: any = null

/**
 * Storage Instance Type Definition
 */
type StoreType = any

const CONTEXT_STRATEGIES = ['summary', 'slidingWindow', 'tokenLimit'] as const
const LEGACY_CONTEXT_EXECUTION_ORDER = ['slidingWindow', 'tokenLimit', 'summary'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Normalizes persisted context-management settings and migrates the legacy
 * order that discarded messages before the summary strategy could read them.
 */
function normalizeContextManagementConfig(value: unknown): ContextManagementConfig {
  const source = isRecord(value) ? value : {}
  const strategySource = isRecord(source.strategies) ? source.strategies : {}
  const slidingWindowSource = isRecord(strategySource.slidingWindow)
    ? strategySource.slidingWindow
    : {}
  const tokenLimitSource = isRecord(strategySource.tokenLimit) ? strategySource.tokenLimit : {}
  const summarySource = isRecord(strategySource.summary) ? strategySource.summary : {}
  const defaults = DEFAULT_CONTEXT_MANAGEMENT_CONFIG
  const positiveInteger = (candidate: unknown, fallback: number): number =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
      ? Math.floor(candidate)
      : fallback
  const enabled = (candidate: unknown, fallback: boolean): boolean =>
    typeof candidate === 'boolean' ? candidate : fallback
  const requestedOrder = Array.isArray(source.executionOrder)
    ? source.executionOrder.filter((item): item is string => typeof item === 'string')
    : undefined
  const validOrder =
    requestedOrder?.filter(
      (strategy): strategy is ContextManagementConfig['executionOrder'][number] =>
        (CONTEXT_STRATEGIES as readonly string[]).includes(strategy),
    ) ?? []
  const uniqueOrder = validOrder.filter((strategy, index) => validOrder.indexOf(strategy) === index)
  const executionOrder: ContextManagementConfig['executionOrder'] =
    !requestedOrder || sameStringArray(uniqueOrder, LEGACY_CONTEXT_EXECUTION_ORDER)
      ? [...defaults.executionOrder]
      : [
          ...uniqueOrder,
          ...CONTEXT_STRATEGIES.filter((strategy) => !uniqueOrder.includes(strategy)),
        ]

  return {
    enabled: enabled(source.enabled, defaults.enabled),
    strategies: {
      slidingWindow: {
        enabled: enabled(slidingWindowSource.enabled, defaults.strategies.slidingWindow.enabled),
        maxMessages: positiveInteger(
          slidingWindowSource.maxMessages,
          defaults.strategies.slidingWindow.maxMessages,
        ),
      },
      tokenLimit: {
        enabled: enabled(tokenLimitSource.enabled, defaults.strategies.tokenLimit.enabled),
        maxTokens: positiveInteger(
          tokenLimitSource.maxTokens,
          defaults.strategies.tokenLimit.maxTokens,
        ),
      },
      summary: {
        enabled: enabled(summarySource.enabled, defaults.strategies.summary.enabled),
        keepRecentMessages: positiveInteger(
          summarySource.keepRecentMessages,
          defaults.strategies.summary.keepRecentMessages,
        ),
        ...(typeof summarySource.summaryPrompt === 'string'
          ? { summaryPrompt: summarySource.summaryPrompt }
          : {}),
      },
    },
    executionOrder,
  }
}

/**
 * Accumulate one request into a per-dimension daily usage bucket.
 */
function accumulateUsage(bucket: DailyUsageBucket | undefined, success: boolean): DailyUsageBucket {
  const base = bucket || { total: 0, success: 0, failed: 0 }
  return {
    total: base.total + 1,
    success: success ? base.success + 1 : base.success,
    failed: success ? base.failed : base.failed + 1,
  }
}

/**
 * Storage Manager Class
 * Responsible for data persistence and encryption
 */
export class StoreManager {
  private store: StoreType | null = null
  private isInitialized: boolean = false
  private mainWindow: BrowserWindow | null = null
  private initializationError: Error | null = null
  private requestLogManager: RequestLogManager | null = null
  private appLogManager: AppLogManager | null = null

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window
  }

  /**
   * Check if storage has initialization error
   */
  hasInitializationError(): boolean {
    return this.initializationError !== null
  }

  /**
   * Get initialization error
   */
  getInitializationError(): Error | null {
    return this.initializationError
  }

  /**
   * Initialize Storage
   * Create storage instance and initialize default data
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    // Dynamically import electron-store (ESM module)
    if (!Store) {
      const module = await import('electron-store')
      Store = module.default
    }

    const storagePath = this.getStoragePath()

    try {
      this.store = new Store({
        name: 'data',
        cwd: storagePath,
        defaults: this.getDefaultData(),
        encryptionKey: this.getEncryptionKey(),
      })

      await this.initializeAppLogManager(storagePath)
      await this.initializeRequestLogManager(storagePath)
      this.initializeDefaultModelMappings()
      await this.initializeDefaultProviders()
      this.isInitialized = true
      this.initializationError = null
      this.cleanOldDailyStats()
    } catch (error) {
      console.error('[Store] Failed to initialize storage:', error)
      this.initializationError = error instanceof Error ? error : new Error(String(error))

      // Try to recover by backing up corrupted data and reinitializing
      try {
        await this.recoverFromCorruptedData(storagePath)
        this.store = new Store({
          name: 'data',
          cwd: storagePath,
          defaults: this.getDefaultData(),
          encryptionKey: this.getEncryptionKey(),
        })
        await this.initializeAppLogManager(storagePath)
        await this.initializeRequestLogManager(storagePath)
        this.initializeDefaultModelMappings()
        this.isInitialized = true
        this.initializationError = null
        console.log('[Store] Successfully recovered from corrupted data')
      } catch (recoveryError) {
        console.error('[Store] Failed to recover from corrupted data:', recoveryError)
        throw this.initializationError
      }
    }
  }

  /**
   * Recover from corrupted data file
   * Backup the corrupted file and create a new one
   */
  private async recoverFromCorruptedData(storagePath: string): Promise<void> {
    const { renameSync, existsSync } = await import('fs')
    const { join } = await import('path')

    const dataPath = join(storagePath, 'data.json')
    const backupPath = join(storagePath, `data.corrupted.${Date.now()}.json`)

    if (existsSync(dataPath)) {
      console.log('[Store] Backing up corrupted data file to:', backupPath)
      try {
        renameSync(dataPath, backupPath)
        console.log('[Store] Corrupted data file backed up successfully')
      } catch (backupError) {
        console.error('[Store] Failed to backup corrupted data:', backupError)
        throw backupError
      }
    }
  }

  /**
   * Get Storage Path
   * Defaults to ~/.fluxmeld/ and can be overridden with FLUXMELD_DATA_DIR so
   * the desktop app and the headless web server can share the same data file.
   */
  private getStoragePath(): string {
    const configured = process.env.FLUXMELD_DATA_DIR?.trim()
    if (configured) {
      return configured
    }
    return join(homedir(), '.fluxmeld')
  }

  /**
   * Get Encryption Key
   * Storage is intentionally unencrypted so the desktop app and the web server
   * can share the exact same data.json. Always returns undefined.
   */
  private getEncryptionKey(): string | undefined {
    return undefined
  }

  /**
   * Get Default Data Structure
   */
  private getDefaultData(): StoreSchema {
    return {
      providers: [],
      accounts: [],
      config: DEFAULT_CONFIG,
      logs: [],
      requestLogs: [],
      systemPrompts: [],
      sessions: [],
      statistics: DEFAULT_STATISTICS,
      userModelOverrides: DEFAULT_USER_MODEL_OVERRIDES,
    }
  }

  private async initializeRequestLogManager(storagePath: string): Promise<void> {
    const config = this.normalizeConfig(this.store?.get('config') || DEFAULT_CONFIG)
    this.requestLogManager = new RequestLogManager({
      storageDir: join(storagePath, 'request-logs'),
      config: config.requestLogConfig,
    })
    await this.requestLogManager.initialize()

    const legacyRequestLogs = this.store?.get('requestLogs') || []
    if (legacyRequestLogs.length > 0) {
      await this.requestLogManager.migrateLegacyLogs(legacyRequestLogs)
      this.store?.set('requestLogs', [])
    }
  }

  private async initializeAppLogManager(storagePath: string): Promise<void> {
    const config = this.normalizeConfig(this.store?.get('config') || DEFAULT_CONFIG)
    this.appLogManager = new AppLogManager({
      storageDir: join(storagePath, 'logs'),
      maxEntries: this.getMaxLogEntries(config),
    })
    await this.appLogManager.initialize()

    const legacyLogs = this.store?.get('logs') || []
    if (legacyLogs.length > 0) {
      await this.appLogManager.migrateLegacyLogs(legacyLogs)
      this.appLogManager.flushSync()
      this.store?.set('logs', [])
    }
  }

  private getMaxLogEntries(config: AppConfig): number {
    return config.logRetentionDays * 1000
  }

  private normalizeConfig(config: Partial<AppConfig>): AppConfig {
    const rawConfig = {
      ...DEFAULT_CONFIG,
      ...config,
    }
    const rawToolCallingConfig = rawConfig.toolCallingConfig ?? rawConfig.toolPromptConfig

    return {
      ...rawConfig,
      modelMappings: normalizeModelMappingsWithDefaults(rawConfig.modelMappings),
      defaultModelMappingsSeeded: config.defaultModelMappingsSeeded,
      requestLogConfig: normalizeRequestLogConfig(
        rawConfig.requestLogConfig || DEFAULT_REQUEST_LOG_CONFIG,
      ),
      registrationApi: {
        ...DEFAULT_CONFIG.registrationApi,
        ...(rawConfig.registrationApi ?? {}),
        // An empty base URL means "use the built-in default" so existing
        // configs saved before the default existed still work.
        baseUrl:
          rawConfig.registrationApi?.baseUrl?.trim() || DEFAULT_CONFIG.registrationApi.baseUrl,
      },
      contextManagement: normalizeContextManagementConfig(rawConfig.contextManagement),
      outboundProxy: {
        ...DEFAULT_CONFIG.outboundProxy,
        ...(rawConfig.outboundProxy ?? {}),
        rotation: {
          ...DEFAULT_CONFIG.outboundProxy.rotation,
          ...(rawConfig.outboundProxy?.rotation ?? {}),
        },
        sources: Array.isArray(rawConfig.outboundProxy?.sources)
          ? rawConfig.outboundProxy.sources
          : [],
        groups: Array.isArray(rawConfig.outboundProxy?.groups)
          ? rawConfig.outboundProxy.groups
          : [],
      },
      toolCallingConfig: normalizeToolCallingConfig(rawToolCallingConfig),
      toolPromptConfig: undefined,
    }
  }

  private initializeDefaultModelMappings(): void {
    const rawConfig = this.store?.get('config') || DEFAULT_CONFIG
    const config = this.normalizeConfig(rawConfig)
    if (config.defaultModelMappingsSeeded) {
      this.store?.set('config', config)
      return
    }
    this.store?.set(
      'config',
      this.normalizeConfig({
        ...config,
        modelMappings: {
          ...createDefaultModelMappings(),
          ...(config.modelMappings || {}),
        },
        defaultModelMappingsSeeded: true,
      }),
    )
  }

  /**
   * Initialize Default Providers
   * Clear provider list, users create providers by adding accounts
   */
  private async initializeDefaultProviders(): Promise<void> {
    const providers = this.store?.get('providers') || []
    const builtinIds = BUILTIN_PROVIDERS.map((p) => p.id)

    const validProviders = providers.filter((p: Provider) => {
      if (p.type === 'builtin') {
        return builtinIds.includes(p.id)
      }
      return true
    })

    const userModelOverrides: UserModelOverrides = {
      ...(this.store?.get('userModelOverrides') || {}),
    }
    let userModelOverridesChanged = false

    const updatedProviders = validProviders.map((p: Provider) => {
      if (p.type === 'builtin') {
        const builtinConfig = BUILTIN_PROVIDERS.find((bp) => bp.id === p.id)
        if (builtinConfig) {
          if (p.id === 'deepseek') {
            const sanitizedOverrides = sanitizeDeepSeekModelOverrides(userModelOverrides[p.id])
            if (JSON.stringify(sanitizedOverrides) !== JSON.stringify(userModelOverrides[p.id])) {
              userModelOverrides[p.id] = sanitizedOverrides
              userModelOverridesChanged = true
            }
          }

          return {
            ...p,
            apiEndpoint: builtinConfig.apiEndpoint,
            chatPath: builtinConfig.chatPath,
            supportedModels: builtinConfig.supportedModels,
            modelMappings: builtinConfig.modelMappings,
            headers: builtinConfig.headers,
            credentialFields: builtinConfig.credentialFields,
            capabilities: builtinConfig.capabilities,
            ui: builtinConfig.ui,
            description: builtinConfig.description,
          }
        }
      }
      return p
    })

    if (userModelOverridesChanged) {
      this.store?.set('userModelOverrides', userModelOverrides)
    }
    this.store?.set('providers', updatedProviders)
  }

  /**
   * Ensure provider exists, create if not
   */
  ensureProviderExists(providerId: string): void {
    this.ensureInitialized()
    const providers = this.store!.get('providers') || []
    const exists = providers.some((p: Provider) => p.id === providerId)

    if (!exists) {
      const builtinConfig = BUILTIN_PROVIDERS.find((bp) => bp.id === providerId)
      if (builtinConfig) {
        const now = Date.now()
        const newProvider: Provider = {
          id: builtinConfig.id,
          name: builtinConfig.name,
          type: 'builtin',
          authType: builtinConfig.authType,
          apiEndpoint: builtinConfig.apiEndpoint,
          chatPath: builtinConfig.chatPath,
          headers: builtinConfig.headers,
          enabled: true,
          createdAt: now,
          updatedAt: now,
          description: builtinConfig.description,
          supportedModels: builtinConfig.supportedModels,
          modelMappings: builtinConfig.modelMappings,
          credentialFields: builtinConfig.credentialFields,
          capabilities: builtinConfig.capabilities,
          ui: builtinConfig.ui,
        }
        providers.push(newProvider)
        this.store!.set('providers', providers)
        console.log('[Store] Created missing provider:', providerId)
      }
    }
  }

  /**
   * Ensure Storage is Initialized
   */
  private ensureInitialized(): void {
    if (!this.isInitialized || !this.store) {
      const errorMsg = this.initializationError
        ? `Storage initialization failed: ${this.initializationError.message}`
        : 'Storage not initialized, please call initialize() first'
      throw new Error(errorMsg)
    }
  }

  private getLogPriority(level: LogLevel): number {
    switch (level) {
      case 'debug':
        return 10
      case 'info':
        return 20
      case 'warn':
        return 30
      case 'error':
        return 40
      default:
        return 20
    }
  }

  private shouldRecordLog(level: LogLevel): boolean {
    const config = this.normalizeConfig(this.store!.get('config') || DEFAULT_CONFIG)
    return this.getLogPriority(level) >= this.getLogPriority(config.logLevel)
  }

  private getCombinedLogs(): LogEntry[] {
    return this.getAppLogManager().exportLogs()
  }

  flushPendingWrites(): void {
    this.appLogManager?.flushSync()
    this.requestLogManager?.flushSync()
  }

  /**
   * Store Sensitive Data
   * Credentials are stored as plaintext so the desktop app and the web server
   * share a single, portable data file.
   */
  encryptData(data: string): string {
    return data
  }

  /**
   * Read Sensitive Data
   * Counterpart to encryptData; credentials are stored as plaintext.
   */
  decryptData(encryptedData: string): string {
    return encryptedData
  }

  /**
   * Encrypt Credentials Object
   * @param credentials Credentials object
   * @returns Encrypted credentials object
   */
  encryptCredentials(credentials: Record<string, string>): Record<string, string> {
    const encrypted: Record<string, string> = {}

    for (const [key, value] of Object.entries(credentials)) {
      encrypted[key] = this.encryptData(value)
    }

    return encrypted
  }

  /**
   * Decrypt Credentials Object
   * @param encryptedCredentials Encrypted credentials object
   * @returns Decrypted credentials object
   */
  decryptCredentials(encryptedCredentials: Record<string, string>): Record<string, string> {
    const decrypted: Record<string, string> = {}

    for (const [key, value] of Object.entries(encryptedCredentials)) {
      decrypted[key] = this.decryptData(value)
    }

    return decrypted
  }

  // ==================== Provider Operations ====================

  /**
   * Get All Providers
   */
  getProviders(): Provider[] {
    this.ensureInitialized()
    return this.store!.get('providers') || []
  }

  /**
   * Get Provider By ID
   */
  getProviderById(id: string): Provider | undefined {
    this.ensureInitialized()
    const providers = (this.store!.get('providers') as Provider[]) || []
    return providers.find((p: Provider) => p.id === id)
  }

  /**
   * Add Provider
   */
  addProvider(provider: Provider): void {
    this.ensureInitialized()
    const providers = (this.store!.get('providers') as Provider[]) || []
    providers.push(provider)
    this.store!.set('providers', providers)
  }

  /**
   * Update Provider
   */
  updateProvider(id: string, updates: Partial<Provider>): Provider | null {
    this.ensureInitialized()
    const providers = (this.store!.get('providers') as Provider[]) || []
    const index = providers.findIndex((p: Provider) => p.id === id)

    if (index === -1) {
      return null
    }

    providers[index] = {
      ...providers[index],
      ...updates,
      updatedAt: Date.now(),
    }

    this.store!.set('providers', providers)
    return providers[index]
  }

  /**
   * Delete Provider
   */
  deleteProvider(id: string): boolean {
    this.ensureInitialized()
    const providers = (this.store!.get('providers') as Provider[]) || []
    const index = providers.findIndex((p: Provider) => p.id === id)

    if (index === -1) {
      return false
    }

    providers.splice(index, 1)
    this.store!.set('providers', providers)

    const accounts = (this.store!.get('accounts') as Account[]) || []
    const filteredAccounts = accounts.filter((a: Account) => a.providerId !== id)
    this.store!.set('accounts', filteredAccounts)

    return true
  }

  // ==================== Model Overrides Operations ====================

  /**
   * Get Model Overrides for a Provider
   * Returns user customizations to built-in provider models
   */
  getModelOverrides(providerId: string): ProviderModelOverrides | undefined {
    this.ensureInitialized()
    const userModelOverrides = this.store!.get('userModelOverrides') || DEFAULT_USER_MODEL_OVERRIDES
    return userModelOverrides[providerId]
  }

  /**
   * Check if Provider has Model Overrides
   * Returns true if provider has user-added models or excluded models
   */
  hasModelOverrides(providerId: string): boolean {
    const overrides = this.getModelOverrides(providerId)
    if (!overrides) return false

    return (
      (overrides.addedModels && overrides.addedModels.length > 0) ||
      (overrides.excludedModels && overrides.excludedModels.length > 0)
    )
  }

  // ==================== Account Operations ====================

  /**
   * Get All Accounts
   * @param includeCredentials Whether to include decrypted credentials
   */
  getAccounts(includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = (this.store!.get('accounts') as Account[]) || []

    if (includeCredentials) {
      return accounts.map((account: Account) => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }

    return accounts
  }

  /**
   * Get Account By ID
   * @param includeCredentials Whether to include decrypted credentials
   */
  getAccountById(id: string, includeCredentials: boolean = false): Account | undefined {
    this.ensureInitialized()
    const accounts = (this.store!.get('accounts') as Account[]) || []
    const account = accounts.find((a: Account) => a.id === id)

    if (account && includeCredentials) {
      return {
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }
    }

    return account
  }

  /**
   * Get Accounts By Provider ID
   */
  getAccountsByProviderId(providerId: string, includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = (this.store!.get('accounts') as Account[]) || []
    const filtered = accounts.filter((a: Account) => a.providerId === providerId)

    if (includeCredentials) {
      return filtered.map((account: Account) => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }

    return filtered
  }

  /**
   * Add Account
   * Credentials are automatically encrypted before storage
   */
  addAccount(account: Account): void {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') || []

    const encryptedAccount: Account = {
      ...account,
      credentials: this.encryptCredentials(account.credentials),
    }

    accounts.push(encryptedAccount)
    this.store!.set('accounts', accounts)
    this.refreshDailyActiveAccountsSnapshot()
  }

  /**
   * Update Account
   */
  updateAccount(id: string, updates: Partial<Account>): Account | null {
    this.ensureInitialized()
    const accounts = (this.store!.get('accounts') as Account[]) || []
    const index = accounts.findIndex((a: Account) => a.id === id)

    if (index === -1) {
      return null
    }

    console.log('[Store] Update account:', {
      id,
      fields: Object.keys(updates),
      credentialsUpdated: Boolean(updates.credentials),
    })

    const updatedAccount: Account = {
      ...accounts[index],
      ...updates,
      updatedAt: Date.now(),
    }

    if (updates.credentials) {
      updatedAccount.credentials = this.encryptCredentials(updates.credentials)
      console.log('[Store] Updated encrypted credentials for account:', id)
    }

    accounts[index] = updatedAccount
    this.store!.set('accounts', accounts)
    this.refreshDailyActiveAccountsSnapshot()

    // Verify save was successful
    const savedAccounts = this.store!.get('accounts') as Account[]
    const savedAccount = savedAccounts.find((a) => a.id === id)
    console.log('[Store] Verify after save:', {
      id,
      saved: Boolean(savedAccount),
    })

    return {
      ...updatedAccount,
      credentials: updates.credentials || this.decryptCredentials(accounts[index].credentials),
    }
  }

  /**
   * Delete Account
   */
  deleteAccount(id: string): boolean {
    this.ensureInitialized()
    const accounts = (this.store!.get('accounts') as Account[]) || []
    const index = accounts.findIndex((a: Account) => a.id === id)

    if (index === -1) {
      return false
    }

    accounts.splice(index, 1)
    this.store!.set('accounts', accounts)
    this.refreshDailyActiveAccountsSnapshot()
    return true
  }

  /**
   * Get Active Accounts
   */
  getActiveAccounts(includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = (this.store!.get('accounts') as Account[]) || []
    const active = accounts.filter((a: Account) => a.status === 'active' && a.enabled !== false)

    if (includeCredentials) {
      return active.map((account: Account) => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }

    return active
  }

  // ==================== Configuration Operations ====================

  /**
   * Get Application Configuration
   */
  getConfig(): AppConfig {
    this.ensureInitialized()
    return this.normalizeConfig(this.store!.get('config') || DEFAULT_CONFIG)
  }

  /**
   * Set Application Configuration
   */
  setConfig(config: AppConfig): void {
    this.ensureInitialized()
    const normalized = this.normalizeConfig(config)
    this.store!.set('config', normalized)
    this.requestLogManager?.setConfig(normalized.requestLogConfig)
  }

  /**
   * Update Application Configuration
   */
  updateConfig(updates: Partial<AppConfig>): AppConfig {
    this.ensureInitialized()
    const currentConfig = this.getConfig()
    const newConfig = {
      ...currentConfig,
      ...updates,
    }

    // Deep merge for nested objects
    if (updates.toolCallingConfig || updates.toolPromptConfig) {
      const incoming = updates.toolCallingConfig ?? updates.toolPromptConfig
      const incomingRecord =
        incoming && typeof incoming === 'object' ? (incoming as Record<string, unknown>) : {}
      const incomingAdvanced =
        incomingRecord.advanced && typeof incomingRecord.advanced === 'object'
          ? (incomingRecord.advanced as Record<string, unknown>)
          : {}

      newConfig.toolCallingConfig = normalizeToolCallingConfig({
        ...currentConfig.toolCallingConfig,
        ...incomingRecord,
        advanced: {
          ...currentConfig.toolCallingConfig.advanced,
          ...incomingAdvanced,
        },
      })
      newConfig.toolPromptConfig = undefined
    }

    if (updates.sessionConfig && currentConfig.sessionConfig) {
      newConfig.sessionConfig = {
        ...currentConfig.sessionConfig,
        ...updates.sessionConfig,
      }
    }

    if (updates.requestLogConfig) {
      newConfig.requestLogConfig = normalizeRequestLogConfig({
        ...currentConfig.requestLogConfig,
        ...updates.requestLogConfig,
      })
    }

    if (updates.outboundProxy) {
      newConfig.outboundProxy = {
        ...currentConfig.outboundProxy,
        ...updates.outboundProxy,
      }
    }

    const normalized = this.normalizeConfig(newConfig)
    this.store!.set('config', normalized)
    this.appLogManager?.setMaxEntries(this.getMaxLogEntries(normalized))
    this.requestLogManager?.setConfig(normalized.requestLogConfig)
    return normalized
  }

  /**
   * Reset Configuration to Default Values
   */
  resetConfig(): AppConfig {
    this.ensureInitialized()
    this.store!.set('config', DEFAULT_CONFIG)
    this.appLogManager?.setMaxEntries(this.getMaxLogEntries(DEFAULT_CONFIG))
    this.requestLogManager?.setConfig(DEFAULT_CONFIG.requestLogConfig)
    return DEFAULT_CONFIG
  }

  // ==================== Log Operations ====================

  /**
   * Add Log Entry
   */
  addLog(
    level: LogLevel,
    message: string,
    data?: {
      accountId?: string
      providerId?: string
      requestId?: string
      data?: Record<string, unknown>
      model?: string
      actualModel?: string
      latency?: number
      isStream?: boolean
      error?: string
      deletedAccounts?: number
    },
  ): LogEntry {
    this.ensureInitialized()
    const entry: LogEntry = {
      id: this.generateId(),
      timestamp: Date.now(),
      level,
      message,
      ...data,
    }

    if (!this.shouldRecordLog(level)) {
      return entry
    }

    this.getAppLogManager().addLog(entry)

    return entry
  }

  /**
   * Get Logs
   * @param limit Limit count
   * @param level Log level filter
   */
  getLogs(filter?: AppLogFilter): LogEntry[] {
    this.ensureInitialized()
    return this.getAppLogManager().getLogs(filter)
  }

  /**
   * Clear Logs
   */
  clearLogs(): void {
    this.ensureInitialized()
    this.getAppLogManager().clearLogs()
    this.store!.set('logs', [])
  }

  replaceLogs(logs: LogEntry[]): void {
    this.ensureInitialized()
    this.getAppLogManager().replaceLogs(logs)
    this.store!.set('logs', [])
  }

  /**
   * Get Log Statistics
   */
  getLogStats(): { total: number; info: number; warn: number; error: number; debug: number } {
    this.ensureInitialized()
    return this.getAppLogManager().getStats()
  }

  /**
   * Get Log Trend
   */
  getLogTrend(
    days: number = 7,
  ): { date: string; total: number; info: number; warn: number; error: number }[] {
    this.ensureInitialized()
    return this.getAppLogManager().getTrend(days)
  }

  /**
   * Get Log Trend for specific account
   * Only counts successful API requests (logs with requestId) to match requestCount
   */
  getAccountLogTrend(
    accountId: string,
    days: number = 7,
  ): { date: string; total: number; info: number; warn: number; error: number }[] {
    this.ensureInitialized()
    return this.getAppLogManager().getAccountTrend(accountId, days)
  }

  /**
   * Export Logs
   */
  exportLogs(format: 'json' | 'txt' = 'json'): string {
    this.ensureInitialized()
    const logs = this.getCombinedLogs()

    if (format === 'json') {
      return JSON.stringify(logs, null, 2)
    }

    return logs
      .map((log: LogEntry) => {
        const time = new Date(log.timestamp).toISOString()
        const level = log.level.toUpperCase().padEnd(5)
        let line = `[${time}] [${level}] ${log.message}`

        if (log.providerId) {
          line += ` | Provider: ${log.providerId}`
        }
        if (log.accountId) {
          line += ` | Account: ${log.accountId}`
        }
        if (log.requestId) {
          line += ` | Request: ${log.requestId}`
        }
        if (log.data) {
          line += ` | Data: ${JSON.stringify(log.data)}`
        }

        return line
      })
      .join('\n')
  }

  /**
   * Get Log By ID
   */
  getLogById(id: string): LogEntry | undefined {
    this.ensureInitialized()
    const logs = this.getCombinedLogs()
    return logs.find((l: LogEntry) => l.id === id)
  }

  /**
   * Clear Expired Logs
   */
  cleanExpiredLogs(): void {
    this.ensureInitialized()
    const config = this.getConfig()
    const logs = this.getCombinedLogs()
    const cutoff = Date.now() - config.logRetentionDays * 24 * 60 * 60 * 1000

    const filtered = logs.filter((l: LogEntry) => l.timestamp >= cutoff)
    this.getAppLogManager().replaceLogs(filtered)
    this.store!.set('logs', [])
  }

  // ==================== Request Log Operations ====================

  /**
   * Add Request Log Entry
   */
  addRequestLog(entry: Omit<RequestLogEntry, 'id'>): RequestLogEntry {
    this.ensureInitialized()
    const newEntry = this.getRequestLogManager().addRequestLog(entry)
    return newEntry
  }

  /**
   * Update Request Log Entry
   */
  updateRequestLog(id: string, updates: Partial<RequestLogEntry>): boolean {
    this.ensureInitialized()
    return this.getRequestLogManager().updateRequestLog(id, updates)
  }

  /**
   * Get Request Logs
   */
  getRequestLogs(limit?: number, filter?: RequestLogFilter): RequestLogEntry[] {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogs(limit, filter, filter?.offset)
  }

  /**
   * Count Request Logs (after filtering, ignoring pagination)
   */
  countRequestLogs(filter?: RequestLogFilter): number {
    this.ensureInitialized()
    return this.getRequestLogManager().countRequestLogs(filter)
  }

  /**
   * Request-log filter options.
   *
   * API keys come from the configured key list (enabled entries only) and are
   * surfaced by name, so wild/unknown keys never appear as filter options and
   * filtering works regardless of whether API-key auth is enabled.
   */
  getRequestLogFilterOptions(): RequestLogFilterOptions {
    this.ensureInitialized()
    const names = new Set<string>()

    for (const key of this.getConfig().apiKeys || []) {
      if (key.enabled && key.name) {
        names.add(key.name)
      }
    }

    return {
      apiKeys: Array.from(names).sort((a, b) => a.localeCompare(b)),
      models: this.getRequestLogManager().getRequestLogModels(),
    }
  }

  /**
   * Get Request Log By ID
   */
  getRequestLogById(id: string): RequestLogEntry | undefined {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogById(id)
  }

  /**
   * Clear Request Logs
   */
  clearRequestLogs(): void {
    this.ensureInitialized()
    this.getRequestLogManager().clearRequestLogs()
    this.store!.set('statistics', DEFAULT_STATISTICS)
  }

  /**
   * Get Request Log Statistics
   */
  getRequestLogStats(filter?: RequestLogFilter): {
    total: number
    success: number
    error: number
    todayTotal: number
    todaySuccess: number
    todayError: number
  } {
    this.ensureInitialized()
    const retained = this.getRequestLogManager().getRequestLogStats(filter)

    // Today's counters prefer the uncapped per-day statistics. The combined
    // apiKey+model filter cannot be derived from the per-day buckets, so it
    // falls back to the (retention-bounded) request-log counts instead.
    const bucket = this.getTodayUsageBucket(filter)
    if (!bucket) {
      return retained
    }

    const status = filter?.status
    return {
      ...retained,
      todayTotal:
        status === 'success' ? bucket.success : status === 'error' ? bucket.failed : bucket.total,
      todaySuccess: status === 'error' ? 0 : bucket.success,
      todayError: status === 'success' ? 0 : bucket.failed,
    }
  }

  /**
   * Today's usage for the given filter derived from the per-day statistics.
   * Returns null when it cannot be derived (combined apiKey+model filter, or no
   * bucket recorded for today) so callers can fall back to retained logs.
   */
  private getTodayUsageBucket(filter?: RequestLogFilter): DailyUsageBucket | null {
    const stats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const day = stats.dailyStats[localDateKey()]
    if (!day) {
      return null
    }

    const empty: DailyUsageBucket = { total: 0, success: 0, failed: 0 }

    if (filter?.apiKey && filter?.model) {
      return null
    }
    if (filter?.model) {
      return day.modelStats?.[filter.model] || empty
    }
    if (filter?.apiKey) {
      return day.apiKeyStats?.[filter.apiKey] || empty
    }
    return {
      total: day.totalRequests,
      success: day.successRequests,
      failed: day.failedRequests,
    }
  }

  /**
   * Get Request Log Trend
   */
  getRequestLogTrend(
    days: number = 7,
  ): { date: string; total: number; success: number; error: number; avgLatency: number }[] {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogTrend(days)
  }

  // ==================== Statistics Operations ====================

  /**
   * Get Persistent Statistics
   */
  getStatistics(): PersistentStatistics {
    this.ensureInitialized()
    return this.store!.get('statistics') || DEFAULT_STATISTICS
  }

  /**
   * Update Statistics
   */
  updateStatistics(updates: Partial<PersistentStatistics>): PersistentStatistics {
    this.ensureInitialized()
    const currentStats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const newStats = {
      ...currentStats,
      ...updates,
      lastUpdated: Date.now(),
    }
    this.store!.set('statistics', newStats)
    return newStats
  }

  /**
   * Record Request in Statistics
   */
  recordRequestInStats(
    success: boolean,
    latency: number,
    model?: string,
    providerId?: string,
    accountId?: string,
    apiKey?: string,
  ): PersistentStatistics {
    this.ensureInitialized()
    const stats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const today = localDateKey()

    const newStats: PersistentStatistics = {
      ...stats,
      totalRequests: stats.totalRequests + 1,
      successRequests: success ? stats.successRequests + 1 : stats.successRequests,
      failedRequests: success ? stats.failedRequests : stats.failedRequests + 1,
      totalLatency: success ? stats.totalLatency + latency : stats.totalLatency,
      lastUpdated: Date.now(),
      modelUsage: { ...stats.modelUsage },
      providerUsage: { ...stats.providerUsage },
      accountUsage: { ...stats.accountUsage },
      dailyStats: { ...stats.dailyStats },
    }

    if (model) {
      newStats.modelUsage[model] = (newStats.modelUsage[model] || 0) + 1
    }

    if (providerId) {
      newStats.providerUsage[providerId] = (newStats.providerUsage[providerId] || 0) + 1
    }

    if (accountId) {
      newStats.accountUsage[accountId] = (newStats.accountUsage[accountId] || 0) + 1
    }

    if (!newStats.dailyStats[today]) {
      newStats.dailyStats[today] = {
        date: today,
        totalRequests: 0,
        successRequests: 0,
        failedRequests: 0,
        totalLatency: 0,
        activeAccounts: 0,
        modelUsage: {},
        providerUsage: {},
        modelStats: {},
        apiKeyStats: {},
      }
    } else {
      const previous = newStats.dailyStats[today]
      newStats.dailyStats[today] = {
        ...previous,
        modelUsage: { ...previous.modelUsage },
        providerUsage: { ...previous.providerUsage },
        modelStats: { ...(previous.modelStats || {}) },
        apiKeyStats: { ...(previous.apiKeyStats || {}) },
      }
    }

    const dayStats = newStats.dailyStats[today]
    dayStats.activeAccounts = this.getActiveAccounts().length
    dayStats.totalRequests++
    if (success) {
      dayStats.successRequests++
      dayStats.totalLatency += latency
    } else {
      dayStats.failedRequests++
    }

    if (model) {
      dayStats.modelUsage[model] = (dayStats.modelUsage[model] || 0) + 1
      dayStats.modelStats![model] = accumulateUsage(dayStats.modelStats![model], success)
    }

    if (providerId) {
      dayStats.providerUsage[providerId] = (dayStats.providerUsage[providerId] || 0) + 1
    }

    if (apiKey) {
      dayStats.apiKeyStats![apiKey] = accumulateUsage(dayStats.apiKeyStats![apiKey], success)
    }

    this.store!.set('statistics', newStats)
    return newStats
  }

  /**
   * Get Today Statistics
   */
  getTodayStatistics(): DailyStatistics {
    this.ensureInitialized()
    const stats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const today = localDateKey()
    return (
      stats.dailyStats[today] || {
        date: today,
        totalRequests: 0,
        successRequests: 0,
        failedRequests: 0,
        totalLatency: 0,
        activeAccounts: this.getActiveAccounts().length,
        modelUsage: {},
        providerUsage: {},
      }
    )
  }

  /**
   * Refresh today's active-account snapshot.
   * Called when accounts change (added/removed/enabled) so the dashboard
   * "vs yesterday" comparison stays accurate even on days without traffic.
   */
  refreshDailyActiveAccountsSnapshot(): void {
    this.ensureInitialized()
    const stats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const today = localDateKey()
    const activeAccounts = this.getActiveAccounts().length

    if (stats.dailyStats[today]?.activeAccounts === activeAccounts) {
      return
    }

    const newStats: PersistentStatistics = {
      ...stats,
      dailyStats: { ...stats.dailyStats },
    }

    newStats.dailyStats[today] = {
      ...(newStats.dailyStats[today] || {
        date: today,
        totalRequests: 0,
        successRequests: 0,
        failedRequests: 0,
        totalLatency: 0,
        modelUsage: {},
        providerUsage: {},
      }),
      activeAccounts,
    }

    this.store!.set('statistics', newStats)
  }

  /**
   * Clean Old Daily Statistics (older than 30 days)
   */
  cleanOldDailyStats(): void {
    this.ensureInitialized()
    const stats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const cutoffDate = localDateKeyOffset(-30)

    const filteredDailyStats: Record<string, DailyStatistics> = {}
    for (const [date, dayStats] of Object.entries(stats.dailyStats)) {
      if (date >= cutoffDate) {
        filteredDailyStats[date] = dayStats as DailyStatistics
      }
    }

    if (Object.keys(filteredDailyStats).length !== Object.keys(stats.dailyStats).length) {
      stats.dailyStats = filteredDailyStats
      this.store!.set('statistics', stats)
    }
  }

  // ==================== System Prompts Operations ====================

  /**
   * Get All System Prompts
   * Merges built-in prompts with custom prompts
   */
  getSystemPrompts(): SystemPrompt[] {
    this.ensureInitialized()
    const customPrompts = this.store!.get('systemPrompts') || []
    return [...BUILTIN_PROMPTS, ...customPrompts]
  }

  /**
   * Get Built-in System Prompts
   */
  getBuiltinPrompts(): SystemPrompt[] {
    return BUILTIN_PROMPTS
  }

  /**
   * Get Custom System Prompts
   */
  getCustomPrompts(): SystemPrompt[] {
    this.ensureInitialized()
    return this.store!.get('systemPrompts') || []
  }

  /**
   * Get System Prompt By ID
   */
  getSystemPromptById(id: string): SystemPrompt | undefined {
    return this.getSystemPrompts().find((p) => p.id === id)
  }

  /**
   * Add Custom System Prompt
   */
  addSystemPrompt(prompt: Omit<SystemPrompt, 'id' | 'createdAt' | 'updatedAt'>): SystemPrompt {
    this.ensureInitialized()
    const prompts = this.store!.get('systemPrompts') || []

    const newPrompt: SystemPrompt = {
      ...prompt,
      id: this.generateId(),
      isBuiltin: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    prompts.push(newPrompt)
    this.store!.set('systemPrompts', prompts)

    return newPrompt
  }

  /**
   * Update Custom System Prompt
   * Cannot update built-in prompts
   */
  updateSystemPrompt(id: string, updates: Partial<SystemPrompt>): SystemPrompt | null {
    this.ensureInitialized()

    // Check if it's a built-in prompt
    if (BUILTIN_PROMPTS.some((p) => p.id === id)) {
      console.warn('Cannot update built-in prompt:', id)
      return null
    }

    const prompts = this.store!.get('systemPrompts') || []
    const index = prompts.findIndex((p: SystemPrompt) => p.id === id)

    if (index === -1) {
      return null
    }

    prompts[index] = {
      ...prompts[index],
      ...updates,
      updatedAt: Date.now(),
    }

    this.store!.set('systemPrompts', prompts)
    return prompts[index]
  }

  /**
   * Delete Custom System Prompt
   * Cannot delete built-in prompts
   */
  deleteSystemPrompt(id: string): boolean {
    this.ensureInitialized()

    // Check if it's a built-in prompt
    if (BUILTIN_PROMPTS.some((p) => p.id === id)) {
      console.warn('Cannot delete built-in prompt:', id)
      return false
    }

    const prompts = this.store!.get('systemPrompts') || []
    const index = prompts.findIndex((p: SystemPrompt) => p.id === id)

    if (index === -1) {
      return false
    }

    prompts.splice(index, 1)
    this.store!.set('systemPrompts', prompts)

    return true
  }

  /**
   * Get System Prompts By Type
   */
  getSystemPromptsByType(type: SystemPrompt['type']): SystemPrompt[] {
    return this.getSystemPrompts().filter((p) => p.type === type)
  }

  // ==================== Session Operations ====================

  /**
   * Get Session Configuration
   */
  getSessionConfig(): SessionConfig {
    this.ensureInitialized()
    const config = this.store!.get('config') || DEFAULT_CONFIG
    return config.sessionConfig || DEFAULT_SESSION_CONFIG
  }

  /**
   * Update Session Configuration
   */
  updateSessionConfig(updates: Partial<SessionConfig>): SessionConfig {
    this.ensureInitialized()
    const currentConfig = this.store!.get('config') || DEFAULT_CONFIG
    const newSessionConfig = {
      ...(currentConfig.sessionConfig || DEFAULT_SESSION_CONFIG),
      ...updates,
    }
    const newConfig = {
      ...currentConfig,
      sessionConfig: newSessionConfig,
    }
    this.store!.set('config', newConfig)
    return newSessionConfig
  }

  /**
   * Get All Sessions
   */
  getSessions(): SessionRecord[] {
    this.ensureInitialized()
    return this.store!.get('sessions') || []
  }

  /**
   * Get Session By ID
   */
  getSessionById(id: string): SessionRecord | undefined {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    return sessions.find((s: SessionRecord) => s.id === id)
  }

  /**
   * Get Active Sessions
   */
  getActiveSessions(): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()

    return sessions.filter(
      (s: SessionRecord) => s.status === 'active' && now - s.lastActiveAt < timeoutMs,
    )
  }

  /**
   * Add Session
   */
  addSession(session: SessionRecord): void {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    this.store!.set('sessions', [...sessions, session])
  }

  /**
   * Update Session
   */
  updateSession(id: string, updates: Partial<SessionRecord>): SessionRecord | null {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const index = sessions.findIndex((s: SessionRecord) => s.id === id)

    if (index === -1) {
      return null
    }

    const updatedSession = {
      ...sessions[index],
      ...updates,
    }

    this.store!.set(
      'sessions',
      sessions.map((session: SessionRecord, sessionIndex: number) =>
        sessionIndex === index ? updatedSession : session,
      ),
    )
    return updatedSession
  }

  /**
   * Add Message to Session
   */
  addMessageToSession(sessionId: string, message: ChatMessage): SessionRecord | null {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const index = sessions.findIndex((s: SessionRecord) => s.id === sessionId)

    if (index === -1) {
      return null
    }

    const config = this.getSessionConfig()
    const session = sessions[index]
    const retainedMessages =
      session.messages.length >= config.maxMessagesPerSession
        ? session.messages.slice(-config.maxMessagesPerSession + 1)
        : session.messages
    const updatedSession: SessionRecord = {
      ...session,
      messages: [...retainedMessages, message],
      lastActiveAt: Date.now(),
    }

    this.store!.set(
      'sessions',
      sessions.map((item: SessionRecord, sessionIndex: number) =>
        sessionIndex === index ? updatedSession : item,
      ),
    )
    return updatedSession
  }

  /**
   * Delete Session
   */
  deleteSession(id: string): boolean {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const index = sessions.findIndex((s: SessionRecord) => s.id === id)

    if (index === -1) {
      return false
    }

    this.store!.set(
      'sessions',
      sessions.filter((_: SessionRecord, sessionIndex: number) => sessionIndex !== index),
    )
    return true
  }

  /**
   * Mark Session as Expired
   */
  expireSession(id: string): SessionRecord | null {
    return this.updateSession(id, { status: 'expired' })
  }

  /**
   * Clean Expired Sessions
   * Always delete sessions with 'expired' status
   * For timed-out active sessions, behavior depends on deleteAfterTimeout config:
   * - If true: Delete them from storage
   * - If false: Mark them as 'expired' (will be deleted on next clean)
   */
  cleanExpiredSessions(): number {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()

    let removedCount = 0

    // Always delete sessions that are already expired
    let remainingSessions = sessions.filter((s: SessionRecord) => {
      if (s.status === 'expired') {
        removedCount++
        return false
      }
      return true
    })

    // Handle timed-out active sessions based on config
    if (config.deleteAfterTimeout) {
      // Delete timed-out sessions from storage
      remainingSessions = remainingSessions.filter((s: SessionRecord) => {
        if (s.status === 'active' && now - s.lastActiveAt >= timeoutMs) {
          removedCount++
          return false
        }
        return true
      })
    } else {
      // Mark timed-out sessions as expired (will be deleted on next clean)
      remainingSessions = remainingSessions.map((s: SessionRecord) => {
        if (s.status === 'active' && now - s.lastActiveAt >= timeoutMs) {
          removedCount++
          return { ...s, status: 'expired' as const }
        }
        return s
      })
    }

    this.store!.set('sessions', remainingSessions)

    return removedCount
  }

  /**
   * Get Sessions By Account ID
   */
  getSessionsByAccountId(accountId: string): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    return sessions.filter((s: SessionRecord) => s.accountId === accountId)
  }

  /**
   * Get Sessions By Provider ID
   */
  getSessionsByProviderId(providerId: string): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    return sessions.filter((s: SessionRecord) => s.providerId === providerId)
  }

  /**
   * Clear All Sessions
   */
  clearAllSessions(): void {
    this.ensureInitialized()
    this.store!.set('sessions', [])
  }

  // ==================== Model Management Operations ====================

  /**
   * Get User Model Overrides
   */
  private getUserModelOverrides(): UserModelOverrides {
    this.ensureInitialized()
    return this.store!.get('userModelOverrides') || DEFAULT_USER_MODEL_OVERRIDES
  }

  /**
   * Set User Model Overrides
   */
  private setUserModelOverrides(overrides: UserModelOverrides): void {
    this.ensureInitialized()
    this.store!.set('userModelOverrides', overrides)
  }

  /**
   * Get Provider Model Overrides
   */
  private getProviderModelOverrides(providerId: string): ProviderModelOverrides {
    const overrides = this.getUserModelOverrides()
    return (
      overrides[providerId] || {
        addedModels: [],
        excludedModels: [],
      }
    )
  }

  /**
   * Get Effective Models for a Provider
   * Merges default models with user overrides
   */
  getEffectiveModels(providerId: string): EffectiveModel[] {
    this.ensureInitialized()

    const provider = this.getProviderById(providerId)
    if (!provider) {
      return []
    }

    const defaultModels = provider.supportedModels || []
    const modelMappings = provider.modelMappings || {}
    const overrides = this.getProviderModelOverrides(providerId)

    const effectiveModels: EffectiveModel[] = []

    defaultModels.forEach((displayName) => {
      if (!overrides.excludedModels.includes(displayName)) {
        const actualModelId = modelMappings[displayName] || displayName
        effectiveModels.push({
          displayName,
          actualModelId,
          isCustom: false,
        })
      }
    })

    overrides.addedModels.forEach((customModel) => {
      effectiveModels.push({
        displayName: customModel.displayName,
        actualModelId: customModel.actualModelId,
        isCustom: true,
      })
    })

    return effectiveModels
  }

  /**
   * Add Custom Model to Provider
   */
  addCustomModel(providerId: string, model: CustomModel): EffectiveModel[] {
    this.ensureInitialized()

    const overrides = this.getUserModelOverrides()

    if (!overrides[providerId]) {
      overrides[providerId] = {
        addedModels: [],
        excludedModels: [],
      }
    }

    const existingModel = overrides[providerId].addedModels.find(
      (m) => m.displayName === model.displayName || m.actualModelId === model.actualModelId,
    )

    if (existingModel) {
      throw new Error(
        `Model with display name "${model.displayName}" or actual ID "${model.actualModelId}" already exists`,
      )
    }

    overrides[providerId].addedModels.push(model)
    this.setUserModelOverrides(overrides)

    return this.getEffectiveModels(providerId)
  }

  /**
   * Remove Model from Provider
   * For default models: add to excludedModels
   * For custom models: remove from addedModels
   */
  removeModel(providerId: string, modelName: string): EffectiveModel[] {
    this.ensureInitialized()

    const provider = this.getProviderById(providerId)
    if (!provider) {
      throw new Error('Provider not found')
    }

    const overrides = this.getUserModelOverrides()

    if (!overrides[providerId]) {
      overrides[providerId] = {
        addedModels: [],
        excludedModels: [],
      }
    }

    const defaultModels = provider.supportedModels || []
    const isDefaultModel = defaultModels.includes(modelName)

    if (isDefaultModel) {
      if (!overrides[providerId].excludedModels.includes(modelName)) {
        overrides[providerId].excludedModels.push(modelName)
      }
    } else {
      overrides[providerId].addedModels = overrides[providerId].addedModels.filter(
        (m) => m.displayName !== modelName,
      )
    }

    this.setUserModelOverrides(overrides)

    return this.getEffectiveModels(providerId)
  }

  /**
   * Reset Provider Models to Default
   * Removes all user overrides for the provider
   */
  resetModels(providerId: string): EffectiveModel[] {
    this.ensureInitialized()

    const overrides = this.getUserModelOverrides()

    if (overrides[providerId]) {
      delete overrides[providerId]
      this.setUserModelOverrides(overrides)
    }

    const builtinConfig = BUILTIN_PROVIDERS.find((provider) => provider.id === providerId)
    if (builtinConfig) {
      const providers = ((this.store!.get('providers') as Provider[]) || []).map((provider) => {
        if (provider.id !== providerId || provider.type !== 'builtin') {
          return provider
        }

        return {
          ...provider,
          apiEndpoint: builtinConfig.apiEndpoint,
          chatPath: builtinConfig.chatPath,
          supportedModels: builtinConfig.supportedModels,
          modelMappings: builtinConfig.modelMappings,
          headers: builtinConfig.headers,
          credentialFields: builtinConfig.credentialFields,
          description: builtinConfig.description,
          updatedAt: Date.now(),
        }
      })
      this.store!.set('providers', providers)
    }

    return this.getEffectiveModels(providerId)
  }

  // ==================== Utility Methods ====================

  /**
   * Generate Unique ID
   */
  generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }

  /**
   * Get Storage Instance (for internal use only)
   */
  getStore(): StoreType | null {
    return this.store
  }

  /**
   * Clear All Data
   */
  clearAll(): void {
    this.ensureInitialized()
    this.appLogManager?.clearLogs()
    this.appLogManager?.flushSync()
    this.store!.clear()
    this.requestLogManager?.clearRequestLogs()
    this.requestLogManager?.flushSync()
  }

  /**
   * Export Data (for backup)
   * Does not include encrypted credential data
   */
  exportData(): Omit<StoreSchema, 'accounts'> & { accounts: Omit<Account, 'credentials'>[] } {
    this.ensureInitialized()
    const providers = this.store!.get('providers') || []
    const accounts = (this.store!.get('accounts') || []).map((a: Account) => {
      const { credentials, ...rest } = a
      return rest
    })
    const config = this.store!.get('config') || DEFAULT_CONFIG
    const logs = this.getAppLogManager().exportLogs()
    const requestLogs = this.getRequestLogManager().exportRequestLogs()
    const systemPrompts = this.store!.get('systemPrompts') || []
    const sessions = this.store!.get('sessions') || []
    const statistics = this.store!.get('statistics') || DEFAULT_STATISTICS
    const userModelOverrides = this.store!.get('userModelOverrides') || DEFAULT_USER_MODEL_OVERRIDES

    return {
      providers,
      accounts,
      config,
      logs,
      requestLogs,
      systemPrompts,
      sessions,
      statistics,
      userModelOverrides,
    }
  }

  /**
   * Get Storage Path
   */
  getStorePath(): string {
    return this.getStoragePath()
  }

  private getRequestLogManager(): RequestLogManager {
    if (!this.requestLogManager) {
      throw new Error('Request log manager is not initialized')
    }
    return this.requestLogManager
  }

  private getAppLogManager(): AppLogManager {
    if (!this.appLogManager) {
      throw new Error('App log manager is not initialized')
    }
    return this.appLogManager
  }
}

// Export singleton instance
export const storeManager = new StoreManager()

// Export types
export type { StoreType }
