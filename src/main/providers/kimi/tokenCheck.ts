import axios from 'axios'
import type { Account, Provider } from '../../../shared/types'
import type { TokenCheckResult } from '../types'
import { buildKimiAuthHeaders, getKimiJwtExpiry } from './token'
import { resolveKimiAccessToken } from './session'

const CHECK_TIMEOUT = 15000

export async function checkKimiToken(
  _provider: Provider,
  account: Account,
): Promise<TokenCheckResult> {
  try {
    // Validation of a new, unsaved account must not rotate its refresh token:
    // the add-account form would otherwise persist the old value.
    const canPersistRefresh = account.id !== 'temp'
    let token = canPersistRefresh
      ? await resolveKimiAccessToken(account)
      : account.credentials.token || account.credentials.accessToken || ''
    if (!token) return { valid: false, error: 'Kimi token is missing' }

    const jwtExpiry = getKimiJwtExpiry(token)
    if (jwtExpiry !== null && jwtExpiry <= Math.floor(Date.now() / 1000)) {
      return {
        valid: false,
        error:
          'This Kimi JWT has expired. The kimi-auth Cookie can remain in the browser after its JWT expires. Check www.kimi.com Local Storage for a current access_token and refresh_token.',
      }
    }

    console.log('[Kimi] Validating configured token')

    const check = (credential: string) =>
      axios.post(
        'https://www.kimi.com/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription',
        {},
        {
          headers: {
            ...buildKimiAuthHeaders(credential),
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            Accept: '*/*',
            Origin: 'https://www.kimi.com',
            Referer: 'https://www.kimi.com/',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        },
      )
    let response = await check(token)

    if (
      (response.status === 401 || response.status === 403) &&
      canPersistRefresh &&
      account.credentials.refresh_token
    ) {
      const refreshed = await resolveKimiAccessToken(account, {
        force: true,
        failedToken: token,
      })
      if (refreshed && refreshed !== token) {
        token = refreshed
        response = await check(token)
      }
    }

    console.log('[Kimi] Response status:', response.status)

    if (response.status === 200 && response.data?.subscription) {
      return {
        valid: true,
        userInfo: {
          name: response.data.subscription.userName,
        },
      }
    }

    return { valid: false, error: 'Token expired or invalid' }
  } catch (error) {
    console.error(
      '[Kimi] Validation error:',
      error instanceof Error ? error.message : 'Unknown error',
    )
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Connection failed',
    }
  }
}
