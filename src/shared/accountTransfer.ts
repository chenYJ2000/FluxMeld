/**
 * Pure helpers for account import/export.
 *
 * Kept free of store/Electron dependencies so they can be unit tested directly.
 * The export format intentionally carries only portable fields (no internal id,
 * status, usage counters or timestamps) so a file can move between instances.
 */

import type { Account } from './types'
import { credentialsEqual } from './accountBatch'

export const ACCOUNT_EXPORT_TYPE = 'fluxmeld-accounts'
export const ACCOUNT_EXPORT_VERSION = 1

/** A single portable account entry inside an export file. */
export interface ExportedAccount {
  providerId: string
  name: string
  email?: string
  credentials: Record<string, string>
  dailyLimit?: number
}

/** Root shape of an account export file. */
export interface AccountExportFile {
  type: typeof ACCOUNT_EXPORT_TYPE
  version: number
  exportedAt: string
  /** Present when the export was scoped to a single provider. */
  providerId?: string
  accounts: ExportedAccount[]
}

/**
 * Project an account down to its portable fields.
 */
export function toExportedAccount(account: Account): ExportedAccount {
  const exported: ExportedAccount = {
    providerId: account.providerId,
    name: account.name,
    credentials: { ...(account.credentials || {}) },
  }

  if (account.email !== undefined) {
    exported.email = account.email
  }

  if (account.dailyLimit !== undefined) {
    exported.dailyLimit = account.dailyLimit
  }

  return exported
}

/**
 * Build an export file from accounts (credentials must already be decrypted).
 */
export function buildAccountExport(
  accounts: Account[],
  providerId?: string,
  now: Date = new Date(),
): AccountExportFile {
  const file: AccountExportFile = {
    type: ACCOUNT_EXPORT_TYPE,
    version: ACCOUNT_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    accounts: accounts.map(toExportedAccount),
  }

  if (providerId) {
    file.providerId = providerId
  }

  return file
}

/**
 * Serialize an export file to pretty-printed JSON.
 */
export function serializeAccountExport(file: AccountExportFile): string {
  return JSON.stringify(file, null, 2)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function normalizeCredentials(value: unknown, index: number): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error(`Account at index ${index} has missing or empty credentials`)
  }

  const credentials: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') {
      throw new Error(`Account at index ${index} has a non-string credential value for "${key}"`)
    }
    credentials[key] = raw
  }

  return credentials
}

/**
 * Parse and validate an account export file. Throws a descriptive error when
 * the input is not a supported export file.
 */
export function parseAccountExport(jsonData: string): AccountExportFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonData)
  } catch {
    throw new Error('Invalid JSON format')
  }

  if (!isRecord(parsed)) {
    throw new Error('Invalid account export file')
  }

  if (parsed.type !== ACCOUNT_EXPORT_TYPE) {
    throw new Error('Unrecognized account export file type')
  }

  if (typeof parsed.version !== 'number' || parsed.version > ACCOUNT_EXPORT_VERSION) {
    throw new Error(`Unsupported account export version: ${String(parsed.version)}`)
  }

  if (!Array.isArray(parsed.accounts)) {
    throw new Error('Account export file is missing the accounts array')
  }

  const accounts = parsed.accounts.map((entry, index): ExportedAccount => {
    if (!isRecord(entry)) {
      throw new Error(`Account at index ${index} is not an object`)
    }

    if (!isNonEmptyString(entry.providerId)) {
      throw new Error(`Account at index ${index} is missing providerId`)
    }

    if (!isNonEmptyString(entry.name)) {
      throw new Error(`Account at index ${index} is missing name`)
    }

    const account: ExportedAccount = {
      providerId: entry.providerId,
      name: entry.name,
      credentials: normalizeCredentials(entry.credentials, index),
    }

    if (entry.email !== undefined) {
      if (typeof entry.email !== 'string') {
        throw new Error(`Account at index ${index} has an invalid email`)
      }
      account.email = entry.email
    }

    if (entry.dailyLimit !== undefined) {
      if (typeof entry.dailyLimit !== 'number' || !Number.isFinite(entry.dailyLimit)) {
        throw new Error(`Account at index ${index} has an invalid dailyLimit`)
      }
      account.dailyLimit = entry.dailyLimit
    }

    return account
  })

  const file: AccountExportFile = {
    type: ACCOUNT_EXPORT_TYPE,
    version: parsed.version,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
    accounts,
  }

  if (isNonEmptyString(parsed.providerId)) {
    file.providerId = parsed.providerId
  }

  return file
}

/**
 * Find an existing account for the same provider whose credentials match the
 * imported entry (exact key/value equality).
 */
export function findDuplicateAccount(
  existing: Account[],
  candidate: ExportedAccount,
): Account | undefined {
  return existing.find(
    (account) =>
      account.providerId === candidate.providerId &&
      credentialsEqual(account.credentials, candidate.credentials),
  )
}
