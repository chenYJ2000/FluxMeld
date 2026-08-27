/**
 * Proxy Service Module - Load Balancer
 * Implements Round Robin and Fill First strategies
 */

import { Account, Provider, LoadBalanceStrategy } from '../store/types'
import { AccountSelection } from './types'
import { storeManager } from '../store/store'

/**
 * Load Balancer
 */
export class LoadBalancer {
  private roundRobinIndex: Map<string, number> = new Map()
  private failedAccounts: Map<string, { count: number; lastFailTime: number }> = new Map()
  private static readonly FAIL_THRESHOLD = 3
  private static readonly RECOVERY_TIME = 60000 // 1 minute

  /** Per-account total dispatch count (every selection increments it). */
  private dispatchCounts: Map<string, number> = new Map()

  /** Per-account number of in-flight requests (concurrency lock). */
  private inFlightCounts: Map<string, number> = new Map()

  /**
   * Mark account as failed
   */
  markAccountFailed(accountId: string): void {
    const current = this.failedAccounts.get(accountId) || { count: 0, lastFailTime: 0 }
    this.failedAccounts.set(accountId, {
      count: current.count + 1,
      lastFailTime: Date.now(),
    })
  }

  /**
   * Clear account failure status
   */
  clearAccountFailure(accountId: string): void {
    this.failedAccounts.delete(accountId)
  }

  /**
   * Release the concurrency lock for an account. Called once the request that
   * selected the account has finished (success, failure, or stream end).
   */
  releaseAccount(accountId: string): void {
    const current = this.inFlightCounts.get(accountId) || 0
    if (current <= 1) {
      this.inFlightCounts.delete(accountId)
    } else {
      this.inFlightCounts.set(accountId, current - 1)
    }
  }

  /**
   * Reset the dispatch counters (e.g. after accounts change).
   */
  resetDispatchCounts(): void {
    this.dispatchCounts.clear()
    this.inFlightCounts.clear()
  }

  /**
   * Check if account is in failure state
   */
  private isAccountInFailure(accountId: string): boolean {
    const failure = this.failedAccounts.get(accountId)
    if (!failure) return false

    if (Date.now() - failure.lastFailTime > LoadBalancer.RECOVERY_TIME) {
      this.failedAccounts.delete(accountId)
      return false
    }

    return failure.count >= LoadBalancer.FAIL_THRESHOLD
  }

  /**
   * Select account
   * @param model Requested model
   * @param strategy Load balance strategy
   * @param preferredProviderId Preferred provider ID
   * @param preferredAccountId Preferred account ID
   */
  selectAccount(
    model: string,
    strategy: LoadBalanceStrategy = 'round-robin',
    preferredProviderId?: string,
    preferredAccountId?: string,
    excludedAccountIds: ReadonlySet<string> = new Set(),
  ): AccountSelection | null {
    const candidates = this.getAvailableAccounts(model, preferredProviderId, excludedAccountIds)

    if (candidates.length === 0) {
      return null
    }

    if (preferredAccountId) {
      const preferred = candidates.find(c => c.account.id === preferredAccountId)
      if (preferred && !this.isAccountInFailure(preferredAccountId)) {
        return preferred
      }
    }

    if (strategy === 'fill-first') {
      return this.selectFillFirst(candidates)
    }

    if (strategy === 'failover') {
      return this.selectFailover(candidates)
    }

    if (strategy === 'least-recently-used') {
      return this.selectLeastRecentlyUsed(candidates)
    }

    if (strategy === 'balanced') {
      return this.selectBalanced(candidates)
    }

    return this.selectRoundRobin(candidates)
  }

  /**
   * Get available accounts list
   */
  private getAvailableAccounts(
    model: string,
    preferredProviderId?: string,
    excludedAccountIds: ReadonlySet<string> = new Set(),
    logAvailability: boolean = true,
  ): AccountSelection[] {
    const providers = storeManager.getProviders().filter(p => p.enabled)
    const candidates: AccountSelection[] = []

    for (const provider of providers) {
      if (preferredProviderId && provider.id !== preferredProviderId) {
        continue
      }

      if (!this.providerSupportsModel(provider, model)) {
        continue
      }

      const accounts = storeManager.getAccountsByProviderId(provider.id, true)
        .filter(account => this.isAccountAvailable(account))
        .filter(account => !this.isAccountInFailure(account.id))
        .filter(account => !excludedAccountIds.has(account.id))

      if (logAvailability) {
        console.log(`[LoadBalancer] Provider ${provider.name} (${provider.id}) has ${accounts.length} available accounts`)
      }

      for (const account of accounts) {
        if (logAvailability) {
          console.log(`[LoadBalancer] Account ${account.name} (${account.id}) is available`)
        }
        candidates.push({
          account,
          provider,
          actualModel: this.mapModel(model, provider),
        })
      }
    }

    return candidates
  }

  /**
   * Check if provider supports model
   */
  private providerSupportsModel(provider: Provider, model: string): boolean {
    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    if (effectiveModels.length === 0) {
      return true
    }

    const { baseModel } = splitQwenModeSuffix(provider, model)
    const normalizedModel = baseModel.toLowerCase()
    const supported = effectiveModels.some(m => {
      const normalizedSupported = m.displayName.toLowerCase()
      if (normalizedSupported.endsWith('*')) {
        return normalizedModel.startsWith(normalizedSupported.slice(0, -1))
      }
      return normalizedSupported === normalizedModel
    })
    
    if (supported) {
      return true
    }

    const config = storeManager.getConfig()
    const globalMapping = config.modelMappings[model] ?? config.modelMappings[baseModel]
    if (globalMapping) {
      if (globalMapping.preferredProviderId) {
        if (globalMapping.preferredProviderId === provider.id) {
          console.log(`[LoadBalancer] Model "${model}" matched preferred provider ${provider.name}`)
          return true
        }
        return false
      }
      
      const actualModel = globalMapping.actualModel
      const normalizedActualModel = actualModel.toLowerCase()
      const actualSupported = effectiveModels.some(m => {
        const normalizedSupported = m.displayName.toLowerCase()
        if (normalizedSupported.endsWith('*')) {
          return normalizedActualModel.startsWith(normalizedSupported.slice(0, -1))
        }
        return normalizedSupported === normalizedActualModel
      })
      
      if (actualSupported) {
        console.log(`[LoadBalancer] Model "${model}" (actualModel: "${actualModel}") supported by ${provider.name}`)
        return true
      }
    }
    
    console.log(`[LoadBalancer] Provider ${provider.name} does not support model ${model}`)
    return false
  }

  /**
   * Check if account is available
   */
  private isAccountAvailable(account: Account): boolean {
    if (account.status !== 'active') {
      return false
    }

    if (account.dailyLimit && account.todayUsed && account.todayUsed >= account.dailyLimit) {
      return false
    }

    return true
  }

  /**
   * Map model name
   */
  private mapModel(model: string, provider: Provider): string {
    console.log(`[LoadBalancer] mapModel called with model="${model}", provider="${provider.name}"`)

    const { baseModel, suffix } = splitQwenModeSuffix(provider, model)
    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    const effectiveModel = effectiveModels.find(m => 
      m.displayName.toLowerCase() === baseModel.toLowerCase()
    )
    
    if (effectiveModel) {
      console.log(`[LoadBalancer] Model mapped from "${model}" to "${effectiveModel.actualModelId}" via effective models`)
      return appendModelSuffix(effectiveModel.actualModelId, suffix)
    }

    const config = storeManager.getConfig()
    const mapping = config.modelMappings[model] ?? config.modelMappings[baseModel]

    if (mapping && (!mapping.preferredProviderId || mapping.preferredProviderId === provider.id)) {
      const actualModel = mapping.actualModel
      console.log(`[LoadBalancer] Model mapped from "${model}" to "${actualModel}" via global mapping`)
      
      const actualEffectiveModel = effectiveModels.find(m => 
        m.displayName.toLowerCase() === actualModel.toLowerCase()
      )
      if (actualEffectiveModel) {
        console.log(`[LoadBalancer] Model further mapped from "${actualModel}" to "${actualEffectiveModel.actualModelId}" via effective models`)
        return appendModelSuffix(actualEffectiveModel.actualModelId, suffix)
      }
      
      return appendModelSuffix(actualModel, suffix)
    }

    console.log(`[LoadBalancer] No mapping found, returning original model "${model}"`)
    return model
  }

  /**
   * Round Robin strategy
   */
  private selectRoundRobin(candidates: AccountSelection[]): AccountSelection {
    const providerIds = [...new Set(candidates.map(c => c.provider.id))]
    const key = providerIds.join(',')

    const currentIndex = this.roundRobinIndex.get(key) || 0
    const selected = candidates[currentIndex % candidates.length]

    this.roundRobinIndex.set(key, (currentIndex + 1) % candidates.length)

    return selected
  }

  /**
   * Fill First strategy
   * Use current account preferentially until limit is reached
   */
  private selectFillFirst(candidates: AccountSelection[]): AccountSelection {
    return candidates.reduce((best, current) => {
      const bestUsed = best.account.todayUsed || 0
      const currentUsed = current.account.todayUsed || 0

      if (currentUsed < bestUsed) {
        return current
      }

      if (currentUsed === bestUsed) {
        const bestLastUsed = best.account.lastUsed || 0
        const currentLastUsed = current.account.lastUsed || 0

        if (currentLastUsed < bestLastUsed) {
          return current
        }
      }

      return best
    })
  }

  /**
   * Failover strategy
   * Select account with least failures, preferring healthy accounts
   */
  private selectFailover(candidates: AccountSelection[]): AccountSelection {
    const healthyCandidates = candidates.filter(c => !this.isAccountInFailure(c.account.id))
    
    if (healthyCandidates.length > 0) {
      return this.selectRoundRobin(healthyCandidates)
    }

    const sortedCandidates = [...candidates].sort((a, b) => {
      const failureA = this.failedAccounts.get(a.account.id)
      const failureB = this.failedAccounts.get(b.account.id)

      const countA = failureA ? failureA.count : 0
      const countB = failureB ? failureB.count : 0

      if (countA !== countB) {
        return countA - countB
      }

      const timeA = failureA ? failureA.lastFailTime : 0
      const timeB = failureB ? failureB.lastFailTime : 0

      return timeA - timeB
    })

    return sortedCandidates[0]
  }

  /**
   * Least Recently Used strategy
   * Select the account that has been unused the longest, giving preference
   * to accounts with lower today-used counts when last-used ties.
   */
  private selectLeastRecentlyUsed(candidates: AccountSelection[]): AccountSelection {
    return candidates.reduce((best, current) => {
      const bestLastUsed = best.account.lastUsed || 0
      const currentLastUsed = current.account.lastUsed || 0

      if (currentLastUsed < bestLastUsed) {
        return current
      }

      if (currentLastUsed === bestLastUsed) {
        const bestUsed = best.account.todayUsed || 0
        const currentUsed = current.account.todayUsed || 0

        if (currentUsed < bestUsed) {
          return current
        }
      }

      return best
    })
  }

  /**
   * Strictly Balanced strategy
   *
   * Keeps the number of times each account has been dispatched within 1 of
   * every other account, even under concurrency:
   *   - Every selection increments that account's dispatch counter.
   *   - Accounts with pending (in-flight) requests are skipped so a slow
   *     account is never piled up with concurrent calls.
   *   - The account with the lowest dispatch count is chosen; ties break by
   *     the fewest in-flight requests, then by today's usage, then name.
   */
  private selectBalanced(candidates: AccountSelection[]): AccountSelection {
    const available = candidates.filter(
      (candidate) => !this.isInFlight(candidate.account.id),
    )
    const pool = available.length > 0 ? available : candidates

    const selected = pool.reduce((best, current) => {
      const bestDispatch = this.dispatchCounts.get(best.account.id) ?? 0
      const currentDispatch = this.dispatchCounts.get(current.account.id) ?? 0

      if (currentDispatch < bestDispatch) return current
      if (currentDispatch > bestDispatch) return best

      const bestInFlight = this.inFlightCounts.get(best.account.id) ?? 0
      const currentInFlight = this.inFlightCounts.get(current.account.id) ?? 0
      if (currentInFlight < bestInFlight) return current
      if (currentInFlight > bestInFlight) return best

      const bestUsed = best.account.todayUsed || 0
      const currentUsed = current.account.todayUsed || 0
      if (currentUsed < bestUsed) return current
      if (currentUsed > bestUsed) return best

      return (current.account.id < best.account.id) ? current : best
    })

    // Acquire the concurrency lock + count the dispatch.
    this.dispatchCounts.set(selected.account.id, (this.dispatchCounts.get(selected.account.id) ?? 0) + 1)
    this.inFlightCounts.set(selected.account.id, (this.inFlightCounts.get(selected.account.id) ?? 0) + 1)
    return selected
  }

  private isInFlight(accountId: string): boolean {
    return (this.inFlightCounts.get(accountId) ?? 0) > 0
  }

  /**
   * Reset Round Robin index
   */
  resetRoundRobinIndex(): void {
    this.roundRobinIndex.clear()
  }

  /**
   * Get available account count
   */
  getAvailableAccountCount(model: string, providerId?: string): number {
    return this.getAvailableAccounts(model, providerId, new Set(), false).length
  }

  /**
   * Get all available models
   */
  getAvailableModels(): string[] {
    const providers = storeManager.getProviders().filter(p => p.enabled)
    const models = new Set<string>()

    for (const provider of providers) {
      const accounts = storeManager.getAccountsByProviderId(provider.id)
        .filter(account => this.isAccountAvailable(account))

      if (accounts.length > 0) {
        const effectiveModels = storeManager.getEffectiveModels(provider.id)
        effectiveModels.forEach(m => models.add(m.displayName))
      }
    }

    return [...models]
  }
}

function splitQwenModeSuffix(provider: Provider, model: string): {
  baseModel: string
  suffix: '-thinking' | '-fast' | ''
} {
  if (provider.id !== 'qwen-ai' && !provider.apiEndpoint.includes('chat.qwen.ai')) {
    return { baseModel: model, suffix: '' }
  }

  const match = /-(thinking|fast)$/i.exec(model)
  if (!match) return { baseModel: model, suffix: '' }

  const suffix = `-${match[1].toLowerCase()}` as '-thinking' | '-fast'
  return { baseModel: model.slice(0, -match[0].length), suffix }
}

function appendModelSuffix(model: string, suffix: '-thinking' | '-fast' | ''): string {
  if (!suffix || model.toLowerCase().endsWith(suffix)) return model
  return `${model}${suffix}`
}

export const loadBalancer = new LoadBalancer()
export default loadBalancer
