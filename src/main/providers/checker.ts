import axios, { AxiosError } from 'axios'
import { getBuiltinProvider } from './builtin'
import { getProviderModule } from './registry'
import type { Provider, ProviderCheckResult, Account } from '../../shared/types'
import type { BuiltinProviderConfig, TokenCheckResult } from './types'

const CHECK_TIMEOUT = 15000

export type { TokenCheckResult } from './types'

export class ProviderChecker {
  static async checkProviderStatus(provider: Provider): Promise<ProviderCheckResult> {
    const startTime = Date.now()

    try {
      const builtinConfig = provider.type === 'builtin' ? getBuiltinProvider(provider.id) : null

      if (builtinConfig) {
        return await this.checkBuiltinProvider(builtinConfig)
      }

      return await this.checkCustomProvider(provider)
    } catch (error) {
      return {
        providerId: provider.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  private static async checkBuiltinProvider(
    config: BuiltinProviderConfig,
  ): Promise<ProviderCheckResult> {
    const startTime = Date.now()

    try {
      const checkUrl = `${config.apiEndpoint.replace('/api', '')}${config.tokenCheckEndpoint || '/health'}`

      const response = await axios({
        method: 'GET',
        url: checkUrl,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })

      const latency = Date.now() - startTime

      if (response.status >= 200 && response.status < 500) {
        return {
          providerId: config.id,
          status: 'online',
          latency,
        }
      }

      return {
        providerId: config.id,
        status: 'offline',
        latency,
        error: `HTTP ${response.status}`,
      }
    } catch (error) {
      return {
        providerId: config.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Connection failed',
      }
    }
  }

  private static async checkCustomProvider(provider: Provider): Promise<ProviderCheckResult> {
    const startTime = Date.now()

    try {
      const response = await axios({
        method: 'GET',
        url: `${provider.apiEndpoint}/models`,
        headers: provider.headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })

      const latency = Date.now() - startTime

      if (response.status >= 200 && response.status < 500) {
        return {
          providerId: provider.id,
          status: 'online',
          latency,
        }
      }

      return {
        providerId: provider.id,
        status: 'offline',
        latency,
        error: `HTTP ${response.status}`,
      }
    } catch (error) {
      return {
        providerId: provider.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Connection failed',
      }
    }
  }

  /**
   * Validate an account's credentials.
   *
   * Provider-specific validation is owned by the provider module
   * (`tokenChecker`); built-in providers without one fall back to the generic
   * endpoint check.
   */
  static async checkAccountToken(provider: Provider, account: Account): Promise<TokenCheckResult> {
    const builtinConfig = provider.type === 'builtin' ? getBuiltinProvider(provider.id) : null

    if (!builtinConfig) {
      return this.checkCustomAccountToken(provider, account)
    }

    const tokenChecker = getProviderModule(provider.id)?.tokenChecker
    if (tokenChecker) {
      return tokenChecker(provider, account)
    }

    if (!builtinConfig.tokenCheckEndpoint) {
      return { valid: true }
    }
    return this.checkGenericToken(builtinConfig, account)
  }

  private static async checkGenericToken(
    config: BuiltinProviderConfig,
    account: Account,
  ): Promise<TokenCheckResult> {
    try {
      const headers: Record<string, string> = {
        ...config.headers,
      }

      const credentials = account.credentials
      if (credentials.token) {
        headers['Authorization'] = `Bearer ${credentials.token}`
      } else if (credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`
      }

      const response = await axios({
        method: config.tokenCheckMethod || 'GET',
        url: `${config.apiEndpoint.replace('/api', '')}${config.tokenCheckEndpoint}`,
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })

      if (response.status >= 200 && response.status < 300) {
        return { valid: true }
      }

      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed, please check credentials' }
      }

      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError ? error.message : 'Connection failed',
      }
    }
  }

  private static async checkCustomAccountToken(
    provider: Provider,
    account: Account,
  ): Promise<TokenCheckResult> {
    try {
      const headers: Record<string, string> = {
        ...provider.headers,
      }

      const credentials = account.credentials
      if (credentials.token) {
        headers['Authorization'] = `Bearer ${credentials.token}`
      } else if (credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`
      }

      const response = await axios({
        method: 'GET',
        url: `${provider.apiEndpoint}/models`,
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })

      if (response.status >= 200 && response.status < 300) {
        return { valid: true }
      }

      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed, please check credentials' }
      }

      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError ? error.message : 'Connection failed',
      }
    }
  }

  static async fetchProviderModels(providerId: string): Promise<{
    supportedModels: string[]
    modelMappings: Record<string, string>
  }> {
    const builtinConfig = getBuiltinProvider(providerId)

    if (!builtinConfig) {
      throw new Error(`Provider ${providerId} not found`)
    }

    if (!builtinConfig.modelsApiEndpoint) {
      throw new Error(`Provider ${providerId} does not support dynamic model fetching`)
    }

    try {
      const headers: Record<string, string> = {
        ...(builtinConfig.modelsApiHeaders || builtinConfig.headers),
      }

      const response = await axios.get(builtinConfig.modelsApiEndpoint, {
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })

      if (response.status !== 200) {
        throw new Error(`Failed to fetch models: HTTP ${response.status}`)
      }

      const models = response.data.data || []
      const supportedModels: string[] = []
      const modelMappings: Record<string, string> = {}

      for (const model of models) {
        if (model.name && model.id) {
          supportedModels.push(model.name)
          modelMappings[model.name] = model.id
        }
      }

      return { supportedModels, modelMappings }
    } catch (error) {
      console.error(`[ProviderChecker] Failed to fetch models for ${providerId}:`, error)
      throw error
    }
  }
}

export default ProviderChecker
