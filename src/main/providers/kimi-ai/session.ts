import axios from 'axios'
import type { Account } from '../../../shared/types'
import { storeManager } from '../../store/store'

export const KIMI_AI_BASE = 'https://www.kimi.ai'

export interface KimiAiSessionTokens {
  token: string
  refresh_token: string
}

export class KimiAiRefreshError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'KimiAiRefreshError'
    this.status = status
  }
}

export function getKimiAiJwtExpiry(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null
  } catch {
    return null
  }
}

export async function exchangeKimiAiRefreshToken(
  refreshToken: string,
): Promise<KimiAiSessionTokens> {
  const cleanRefresh = refreshToken.trim()
  if (!cleanRefresh) throw new KimiAiRefreshError('Kimi AI refresh token is missing', 401)

  let response
  try {
    response = await axios.get(`${KIMI_AI_BASE}/api/auth/token/refresh`, {
      headers: {
        Authorization: `Bearer ${cleanRefresh}`,
        Accept: 'application/json, text/plain, */*',
        Origin: KIMI_AI_BASE,
        Referer: `${KIMI_AI_BASE}/`,
      },
      timeout: 15000,
      validateStatus: () => true,
    })
  } catch (error) {
    throw new KimiAiRefreshError(
      error instanceof Error
        ? `Kimi AI refresh request failed: ${error.message}`
        : 'Kimi AI refresh request failed',
      503,
    )
  }

  if (response.status !== 200) {
    throw new KimiAiRefreshError(
      `Kimi AI refresh failed (HTTP ${response.status})`,
      response.status,
    )
  }

  const token = response.data?.access_token
  const nextRefresh = response.data?.refresh_token || cleanRefresh
  if (typeof token !== 'string' || !token.trim() || typeof nextRefresh !== 'string') {
    throw new KimiAiRefreshError('Kimi AI refresh response has no access token', 502)
  }

  return { token: token.trim(), refresh_token: nextRefresh.trim() }
}

const refreshFlights = new Map<string, Promise<KimiAiSessionTokens>>()
const ACCESS_REFRESH_LEEWAY_SECONDS = 5 * 60

function getCurrentAccount(account: Account): Account {
  if (!account.id || account.id === 'temp') return account
  return storeManager.getAccountById(account.id, true) || account
}

export async function resolveKimiAiAccessToken(
  account: Account,
  options: { force?: boolean; failedToken?: string } = {},
): Promise<string> {
  const current = getCurrentAccount(account)
  const accessToken = current.credentials.token || current.credentials.accessToken || ''
  const refreshToken = current.credentials.refresh_token || ''
  const expiry = getKimiAiJwtExpiry(accessToken)
  const expiredSoon =
    expiry !== null && expiry <= Math.floor(Date.now() / 1000) + ACCESS_REFRESH_LEEWAY_SECONDS

  if (options.failedToken && accessToken && accessToken !== options.failedToken) {
    return accessToken
  }
  if (!options.force && accessToken && !expiredSoon) return accessToken
  if (!refreshToken) return accessToken

  let flight = refreshFlights.get(refreshToken)
  if (!flight) {
    flight = exchangeKimiAiRefreshToken(refreshToken)
    refreshFlights.set(refreshToken, flight)
    void flight
      .finally(() => {
        if (refreshFlights.get(refreshToken) === flight) refreshFlights.delete(refreshToken)
      })
      .catch(() => {})
  }

  let next: KimiAiSessionTokens
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
        credentials: {
          token: next.token,
          refresh_token: next.refresh_token,
        },
        status: 'active',
        errorMessage: undefined,
      })
    } else if (latest?.credentials.token) {
      return latest.credentials.token
    }
  }

  return next.token
}
