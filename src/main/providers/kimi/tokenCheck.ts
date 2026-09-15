import axios, { AxiosError } from 'axios'
import type { Account, Provider } from '../../../shared/types'
import type { TokenCheckResult } from '../types'
import { buildKimiAuthHeaders } from './token'

const CHECK_TIMEOUT = 15000

export async function checkKimiToken(
  _provider: Provider,
  account: Account,
): Promise<TokenCheckResult> {
  const token = account.credentials.token

  try {
    console.log('[Kimi] Validating configured token')

    const response = await axios.post(
      'https://www.kimi.com/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription',
      {},
      {
        headers: {
          ...buildKimiAuthHeaders(token),
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
      error: error instanceof AxiosError ? error.message : 'Connection failed',
    }
  }
}
