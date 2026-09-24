import type { Account } from '../../../shared/types'
import { storeManager } from '../../store/store'
import { getKimiAiJwtExpiry, resolveKimiAiAccessToken } from './session'

const ACCESS_REFRESH_WINDOW_SECONDS = 24 * 60 * 60
const REFRESH_REFRESH_WINDOW_SECONDS = 7 * 24 * 60 * 60
const REFRESH_CONCURRENCY = 3

export function needsKimiAiBackgroundRefresh(
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
  const accessExpiry = getKimiAiJwtExpiry(accessToken)
  const refreshExpiry = getKimiAiJwtExpiry(account.credentials.refresh_token)
  return (
    !accessToken ||
    (accessExpiry !== null && accessExpiry <= nowSeconds + ACCESS_REFRESH_WINDOW_SECONDS) ||
    (refreshExpiry !== null && refreshExpiry <= nowSeconds + REFRESH_REFRESH_WINDOW_SECONDS)
  )
}

export async function maintainKimiAiSessions(): Promise<void> {
  const accounts = storeManager
    .getAccountsByProviderId('kimi-ai', true)
    .filter((account) => needsKimiAiBackgroundRefresh(account))

  for (let index = 0; index < accounts.length; index += REFRESH_CONCURRENCY) {
    await Promise.all(
      accounts.slice(index, index + REFRESH_CONCURRENCY).map(async (account) => {
        try {
          await resolveKimiAiAccessToken(account, { force: true })
        } catch (error) {
          const status =
            error && typeof error === 'object' && 'status' in error
              ? Number(error.status)
              : undefined
          console.warn('[Kimi AI] Background token refresh failed', {
            accountId: account.id,
            status: Number.isFinite(status) ? status : undefined,
          })
        }
      }),
    )
  }
}
