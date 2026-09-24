import axios from 'axios'
import type { Account } from '../../../shared/types'
import { storeManager } from '../../store/store'
import { getKimiJwtExpiry } from './token'

const REFRESH_URL = 'https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken'
const REFRESH_LEEWAY_SECONDS = 2 * 60

export interface KimiSessionTokens {
  token: string
  refresh_token: string
}

export class KimiRefreshError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'KimiRefreshError'
    this.status = status
  }
}

/** The kimi.com web client calls this Connect RPC with its Local Storage refresh_token. */
export async function exchangeKimiRefreshToken(refreshToken: string): Promise<KimiSessionTokens> {
  const cleanRefresh = refreshToken.trim()
  if (!cleanRefresh) throw new KimiRefreshError('Kimi refresh_token is missing', 401)

  let response
  try {
    response = await axios.post(
      REFRESH_URL,
      { refresh_token: cleanRefresh },
      {
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          Accept: 'application/json',
          Origin: 'https://www.kimi.com',
          Referer: 'https://www.kimi.com/',
          'X-Msh-Platform': 'web',
          'R-Timezone': 'Asia/Shanghai',
        },
        timeout: 15000,
        validateStatus: () => true,
      },
    )
  } catch (error) {
    throw new KimiRefreshError(
      error instanceof Error
        ? `Kimi refresh request failed: ${error.message}`
        : 'Kimi refresh request failed',
      503,
    )
  }

  if (response.status !== 200) {
    throw new KimiRefreshError(`Kimi refresh failed (HTTP ${response.status})`, response.status)
  }

  const token = response.data?.access_token || response.data?.accessToken
  const nextRefresh = response.data?.refresh_token || response.data?.refreshToken
  if (
    typeof token !== 'string' ||
    !token.trim() ||
    typeof nextRefresh !== 'string' ||
    !nextRefresh.trim()
  ) {
    throw new KimiRefreshError('Kimi refresh response is missing tokens', 502)
  }

  return { token: token.trim(), refresh_token: nextRefresh.trim() }
}

const refreshFlights = new Map<string, Promise<KimiSessionTokens>>()

function getCurrentAccount(account: Account): Account {
  if (!account.id || account.id === 'temp') return account
  return storeManager.getAccountById(account.id, true) || account
}

export async function resolveKimiAccessToken(
  account: Account,
  options: { force?: boolean; failedToken?: string } = {},
): Promise<string> {
  const current = getCurrentAccount(account)
  const accessToken = current.credentials.token || current.credentials.accessToken || ''
  const refreshToken = current.credentials.refresh_token || ''
  const expiry = getKimiJwtExpiry(accessToken)
  const expiredSoon =
    expiry !== null && expiry <= Math.floor(Date.now() / 1000) + REFRESH_LEEWAY_SECONDS

  if (options.failedToken && accessToken && accessToken !== options.failedToken) {
    return accessToken
  }
  if (!options.force && accessToken && !expiredSoon) return accessToken
  if (!refreshToken) return accessToken

  let flight = refreshFlights.get(refreshToken)
  if (!flight) {
    flight = exchangeKimiRefreshToken(refreshToken)
    refreshFlights.set(refreshToken, flight)
    void flight
      .finally(() => {
        if (refreshFlights.get(refreshToken) === flight) refreshFlights.delete(refreshToken)
      })
      .catch(() => {})
  }

  let next: KimiSessionTokens
  try {
    next = await flight
  } catch (error) {
    if (
      !options.force &&
      accessToken &&
      expiry !== null &&
      expiry > Math.floor(Date.now() / 1000)
    ) {
      return accessToken
    }
    throw error
  }

  if (account.id && account.id !== 'temp') {
    const latest = storeManager.getAccountById(account.id, true)
    if (
      latest?.credentials.refresh_token === refreshToken &&
      (latest.credentials.token || latest.credentials.accessToken || '') === accessToken
    ) {
      storeManager.updateAccount(account.id, {
        credentials: { token: next.token, refresh_token: next.refresh_token },
        status: 'active',
        errorMessage: undefined,
      })
    } else if (latest?.credentials.token) {
      return latest.credentials.token
    }
  }

  return next.token
}
