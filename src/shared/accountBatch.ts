/**
 * Pure helpers for account batch/query operations.
 *
 * Kept free of store/Electron dependencies so they can be unit tested directly.
 */

import type { Account, AccountQueryRequest } from './types'

/**
 * Deep-ish equality for credential maps (all keys and values must match).
 */
export function credentialsEqual(
  a: Record<string, string> | undefined | null,
  b: Record<string, string> | undefined | null,
): boolean {
  const left = a || {}
  const right = b || {}
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)

  if (leftKeys.length !== rightKeys.length) {
    return false
  }

  return leftKeys.every((key) => left[key] === right[key])
}

/**
 * Whether an account matches a query request. All provided filters must match
 * (logical AND); string filters are case-insensitive substring matches.
 */
export function matchesAccountQuery(account: Account, query: AccountQueryRequest): boolean {
  if (query.ids && query.ids.length > 0 && !query.ids.includes(account.id)) {
    return false
  }

  if (query.providerId && account.providerId !== query.providerId) {
    return false
  }

  if (query.status && account.status !== query.status) {
    return false
  }

  if (query.name && !(account.name || '').toLowerCase().includes(query.name.toLowerCase())) {
    return false
  }

  if (query.email && !(account.email || '').toLowerCase().includes(query.email.toLowerCase())) {
    return false
  }

  return true
}
