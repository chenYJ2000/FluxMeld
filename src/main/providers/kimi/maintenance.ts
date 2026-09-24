import type { Account } from '../../../shared/types'
import { storeManager } from '../../store/store'
import { getKimiJwtExpiry } from './token'
import { resolveKimiAccessToken } from './session'

const REFRESH_WINDOW_SECONDS = 5 * 60
const REFRESH_CONCURRENCY = 3

export function needsKimiBackgroundRefresh(
  account: Account,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (
    account.status !== 'active' ||
    account.enabled === false ||
    !account.credentials.refresh_token
  ) {
    return false
  }

  const accessToken = account.credentials.token || account.credentials.accessToken || ''
  const expiry = getKimiJwtExpiry(accessToken)
  return !accessToken || (expiry !== null && expiry <= nowSeconds + REFRESH_WINDOW_SECONDS)
}

export async function maintainKimiSessions(): Promise<void> {
  const accounts = storeManager
    .getAccountsByProviderId('kimi', true)
    .filter((account) => needsKimiBackgroundRefresh(account))

  for (let index = 0; index < accounts.length; index += REFRESH_CONCURRENCY) {
    await Promise.all(
      accounts.slice(index, index + REFRESH_CONCURRENCY).map(async (account) => {
        try {
          await resolveKimiAccessToken(account, { force: true })
        } catch (error) {
          const status =
            error && typeof error === 'object' && 'status' in error
              ? Number(error.status)
              : undefined
          console.warn('[Kimi] Background token refresh failed', {
            accountId: account.id,
            status: Number.isFinite(status) ? status : undefined,
          })
        }
      }),
    )
  }
}
