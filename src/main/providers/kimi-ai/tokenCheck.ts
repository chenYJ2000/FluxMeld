import axios from 'axios'
import type { Account, Provider } from '../../../shared/types'
import type { TokenCheckResult } from '../types'
import { KIMI_AI_BASE, resolveKimiAiAccessToken } from './session'

async function getKimiAiProfile(token: string) {
  return axios.get(`${KIMI_AI_BASE}/api/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/plain, */*',
      Origin: KIMI_AI_BASE,
      Referer: `${KIMI_AI_BASE}/`,
    },
    timeout: 15000,
    validateStatus: () => true,
  })
}

export async function checkKimiAiToken(
  _provider: Provider,
  account: Account,
): Promise<TokenCheckResult> {
  if (!account.credentials.token && !account.credentials.refresh_token) {
    return { valid: false, error: 'Kimi AI access_token is missing' }
  }

  try {
    let token = await resolveKimiAiAccessToken(account)
    if (!token) return { valid: false, error: 'Kimi AI access_token is missing' }
    let response = await getKimiAiProfile(token)

    if ((response.status === 401 || response.status === 403) && account.credentials.refresh_token) {
      const refreshed = await resolveKimiAiAccessToken(account, {
        force: true,
        failedToken: token,
      })
      if (refreshed !== token) {
        token = refreshed
        response = await getKimiAiProfile(token)
      }
    }

    if (response.status !== 200 || !response.data?.id) {
      return {
        valid: false,
        error:
          response.status === 401 || response.status === 403
            ? 'Kimi AI session expired; sign in again'
            : `Kimi AI validation failed (HTTP ${response.status})`,
      }
    }

    return {
      valid: true,
      userInfo: {
        name: response.data.name,
        email: response.data.email,
      },
    }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Kimi AI validation request failed',
    }
  }
}
