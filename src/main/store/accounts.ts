/**
 * Credential Storage Module - Account Management API
 * Provides CRUD operations for accounts
 */

import { storeManager } from './store'
import { Account, AccountStatus, ValidationResult } from './types'
import { validateCredentials } from './validator'
import {
  buildAccountExport,
  findDuplicateAccount,
  parseAccountExport,
  serializeAccountExport,
} from '../../shared/accountTransfer'
import type { AccountImportResult } from '../../shared/types'

/**
 * Account Manager class
 * Provides all operations related to accounts
 */
export class AccountManager {
  /**
   * Get all accounts
   * @param includeCredentials Whether to include credentials (sensitive data)
   */
  static getAll(includeCredentials: boolean = false): Account[] {
    return storeManager.getAccounts(includeCredentials)
  }

  /**
   * Get account by ID
   * @param id Account ID
   * @param includeCredentials Whether to include credentials
   */
  static getById(id: string, includeCredentials: boolean = false): Account | undefined {
    return storeManager.getAccountById(id, includeCredentials)
  }

  /**
   * Get account list by provider ID
   * @param providerId Provider ID
   * @param includeCredentials Whether to include credentials
   */
  static getByProviderId(providerId: string, includeCredentials: boolean = false): Account[] {
    return storeManager.getAccountsByProviderId(providerId, includeCredentials)
  }

  /**
   * Get all active accounts
   * @param includeCredentials Whether to include credentials
   */
  static getActive(includeCredentials: boolean = false): Account[] {
    return storeManager.getActiveAccounts(includeCredentials)
  }

  /**
   * Create new account
   * @param data Account data
   * @returns Created account
   */
  static create(data: {
    providerId: string
    name: string
    email?: string
    credentials: Record<string, string>
    dailyLimit?: number
  }): Account {
    // Ensure provider exists before creating account
    storeManager.ensureProviderExists(data.providerId)

    const provider = storeManager.getProviderById(data.providerId)

    if (!provider) {
      throw new Error(`Provider not found: ${data.providerId}`)
    }

    const now = Date.now()
    const account: Account = {
      id: storeManager.generateId(),
      providerId: data.providerId,
      name: data.name,
      email: data.email,
      credentials: data.credentials,
      status: 'active',
      enabled: true,
      createdAt: now,
      updatedAt: now,
      requestCount: 0,
      todayUsed: 0,
      dailyLimit: data.dailyLimit,
      lastStatusCheck: now,
      lastUsed: now,
    }

    storeManager.addAccount(account)

    storeManager.addLog('info', `Created account: ${account.name}`, {
      accountId: account.id,
      providerId: account.providerId,
    })

    return account
  }

  /**
   * Export accounts (credentials included) as a JSON string.
   * @param providerId Optional, only export accounts of this provider
   */
  static exportAccounts(providerId?: string): string {
    const accounts = providerId
      ? storeManager.getAccountsByProviderId(providerId, true)
      : storeManager.getAccounts(true)

    return serializeAccountExport(buildAccountExport(accounts, providerId))
  }

  /**
   * Import accounts from an export file. Accounts whose credentials already
   * exist for the target provider are skipped rather than created again.
   * @param jsonData Export file content
   * @param providerIdOverride Optional, force every imported account onto this provider
   * @returns Import summary
   */
  static importAccounts(jsonData: string, providerIdOverride?: string): AccountImportResult {
    const file = parseAccountExport(jsonData)
    const result: AccountImportResult = {
      total: file.accounts.length,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    }

    file.accounts.forEach((item, index) => {
      const providerId = providerIdOverride || item.providerId

      if (!providerId || !storeManager.getProviderById(providerId)) {
        result.failed++
        result.errors.push({
          index,
          name: item.name,
          providerId,
          code: 'provider_not_found',
          message: `Provider not found: ${providerId || '(unknown)'}`,
        })
        return
      }

      const existing = storeManager.getAccountsByProviderId(providerId, true)
      if (findDuplicateAccount(existing, { ...item, providerId })) {
        result.skipped++
        return
      }

      try {
        this.create({
          providerId,
          name: item.name,
          email: item.email,
          credentials: item.credentials,
          dailyLimit: item.dailyLimit,
        })
        result.succeeded++
      } catch (error) {
        result.failed++
        result.errors.push({
          index,
          name: item.name,
          providerId,
          code: 'create_failed',
          message: error instanceof Error ? error.message : 'Failed to create account',
        })
      }
    })

    storeManager.addLog(
      'info',
      `Imported accounts: ${result.succeeded} added, ${result.skipped} skipped, ${result.failed} failed`,
    )

    return result
  }

  /**
   * Update account
   * @param id Account ID
   * @param updates Update data
   * @returns Updated account
   */
  static update(id: string, updates: Partial<Omit<Account, 'id' | 'createdAt'>>): Account | null {
    const existing = storeManager.getAccountById(id)

    if (!existing) {
      throw new Error(`Account not found: ${id}`)
    }

    const updated = storeManager.updateAccount(id, updates)

    if (updated) {
      storeManager.addLog('info', `Updated account: ${existing.name}`, {
        accountId: id,
        providerId: existing.providerId,
      })
    }

    return updated
  }

  /**
   * Delete account
   * @param id Account ID
   * @returns Whether deletion was successful
   */
  static delete(id: string): boolean {
    const account = storeManager.getAccountById(id)

    if (!account) {
      return false
    }

    const result = storeManager.deleteAccount(id)

    if (result) {
      storeManager.addLog('info', `Deleted account: ${account.name}`, {
        accountId: id,
        providerId: account.providerId,
      })
    }

    return result
  }

  /**
   * Update account status
   * @param id Account ID
   * @param status New status
   * @param errorMessage Error message (optional)
   */
  static updateStatus(id: string, status: AccountStatus, errorMessage?: string): Account | null {
    return this.update(id, { status, errorMessage })
  }

  /**
   * Update last used time
   * @param id Account ID
   */
  static touchLastUsed(id: string): void {
    const account = storeManager.getAccountById(id)

    if (account) {
      storeManager.updateAccount(id, {
        lastUsed: Date.now(),
      })
    }
  }

  /**
   * Increment request count
   * @param id Account ID
   */
  static incrementRequestCount(id: string): void {
    const account = storeManager.getAccountById(id)

    if (account) {
      storeManager.updateAccount(id, {
        requestCount: (account.requestCount || 0) + 1,
        todayUsed: (account.todayUsed || 0) + 1,
        lastUsed: Date.now(),
      })
    }
  }

  /**
   * Reset daily usage count
   * Should be called at midnight
   */
  static resetDailyUsage(): void {
    const accounts = storeManager.getAccounts()

    for (const account of accounts) {
      storeManager.updateAccount(account.id, { todayUsed: 0 })
    }

    storeManager.addLog('info', 'Reset daily usage count for all accounts')
  }

  /**
   * Validate account credentials
   * @param id Account ID
   * @returns Validation result
   */
  static async validate(id: string): Promise<ValidationResult> {
    const account = storeManager.getAccountById(id, true)

    if (!account) {
      return {
        valid: false,
        error: 'Account not found',
        validatedAt: Date.now(),
      }
    }

    const provider = storeManager.getProviderById(account.providerId)

    if (!provider) {
      return {
        valid: false,
        error: 'Provider not found',
        validatedAt: Date.now(),
      }
    }

    const result = await validateCredentials(provider, account.credentials)

    if (result.valid) {
      this.updateStatus(id, 'active')

      if (result.accountInfo?.email) {
        storeManager.updateAccount(id, { email: result.accountInfo.email })
      }
    } else {
      this.updateStatus(id, 'error', result.error)
    }

    return result
  }

  /**
   * Batch validate accounts with bounded concurrency
   * @param providerId Optional, only validate accounts of this provider
   * @param concurrency Maximum number of validations running at once
   * @returns Validation result mapping
   */
  static async validateAll(
    providerId?: string,
    concurrency = 5,
  ): Promise<Map<string, ValidationResult>> {
    const accounts = providerId
      ? storeManager.getAccountsByProviderId(providerId, true)
      : storeManager.getAccounts(true)
    const results = new Map<string, ValidationResult>()

    let cursor = 0
    const limit = Math.max(1, Math.min(concurrency, accounts.length))

    const worker = async (): Promise<void> => {
      while (cursor < accounts.length) {
        const account = accounts[cursor]
        cursor += 1
        results.set(account.id, await this.validate(account.id))
      }
    }

    await Promise.all(Array.from({ length: limit }, () => worker()))

    return results
  }

  /**
   * Check if account is available
   * @param id Account ID
   * @returns Whether account is available
   */
  static isAvailable(id: string): boolean {
    const account = storeManager.getAccountById(id)

    if (!account || account.status !== 'active' || account.enabled === false) {
      return false
    }

    if (account.dailyLimit && account.todayUsed && account.todayUsed >= account.dailyLimit) {
      return false
    }

    return true
  }

  /**
   * Get available account list
   * @param providerId Optional, filter by provider
   * @returns Available account list
   */
  static getAvailable(providerId?: string): Account[] {
    let accounts = storeManager.getActiveAccounts()

    if (providerId) {
      accounts = accounts.filter((a) => a.providerId === providerId)
    }

    return accounts.filter((account) => {
      if (account.status !== 'active' || account.enabled === false) {
        return false
      }

      if (account.dailyLimit && account.todayUsed && account.todayUsed >= account.dailyLimit) {
        return false
      }

      return true
    })
  }

  /**
   * Select next available account (load balancing)
   * @param providerId Provider ID
   * @param strategy Load balance strategy
   * @returns Selected account or null
   */
  static selectNext(
    providerId: string,
    strategy: 'round-robin' | 'fill-first' = 'round-robin',
  ): Account | null {
    const available = this.getAvailable(providerId)

    if (available.length === 0) {
      return null
    }

    if (strategy === 'fill-first') {
      return available.reduce((prev, curr) => {
        const prevUsed = prev.todayUsed || 0
        const currUsed = curr.todayUsed || 0
        return currUsed < prevUsed ? curr : prev
      })
    }

    const lastUsed = available.reduce(
      (latest, account) => {
        if (!account.lastUsed) return latest
        if (!latest) return account
        return account.lastUsed > (latest.lastUsed || 0) ? account : latest
      },
      null as Account | null,
    )

    if (!lastUsed) {
      return available[0]
    }

    const lastIndex = available.findIndex((a) => a.id === lastUsed.id)
    const nextIndex = (lastIndex + 1) % available.length

    return available[nextIndex]
  }

  /**
   * Get account statistics
   */
  static getStatistics(): {
    total: number
    active: number
    inactive: number
    expired: number
    error: number
  } {
    const accounts = storeManager.getAccounts()

    return {
      total: accounts.length,
      active: accounts.filter((a) => a.status === 'active').length,
      inactive: accounts.filter((a) => a.status === 'inactive').length,
      expired: accounts.filter((a) => a.status === 'expired').length,
      error: accounts.filter((a) => a.status === 'error').length,
    }
  }
}

export default AccountManager
