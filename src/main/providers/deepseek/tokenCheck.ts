import axios, { AxiosError } from 'axios'
import type { Account, Provider } from '../../../shared/types'
import type { TokenCheckResult } from '../types'

const CHECK_TIMEOUT = 15000

export async function checkDeepSeekToken(
  _provider: Provider,
  account: Account,
): Promise<TokenCheckResult> {
  const token = account.credentials.token

  try {
    console.log('[DeepSeek] Validating configured token')

    const response = await axios.get('https://chat.deepseek.com/api/v0/users/current', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: '*/*',
        Origin: 'https://chat.deepseek.com',
        Referer: 'https://chat.deepseek.com/',
      },
      timeout: CHECK_TIMEOUT,
      validateStatus: () => true,
    })

    console.log('[DeepSeek] Response status:', response.status)

    // Response format: { code: 0, data: { biz_data: { ... } } }
    if (response.status === 200 && response.data?.code === 0 && response.data?.data?.biz_data) {
      const bizData = response.data.data.biz_data
      return {
        valid: true,
        userInfo: {
          name: bizData.id_profile?.name,
          email: bizData.email,
        },
      }
    }

    if (
      response.status === 401 ||
      response.data?.code === 40003 ||
      response.data?.data?.biz_code === 40003
    ) {
      return { valid: false, error: 'Token expired or invalid' }
    }

    return {
      valid: false,
      error: `Validation failed: ${response.data?.msg || response.data?.message || `HTTP ${response.status}`}`,
    }
  } catch (error) {
    console.error(
      '[DeepSeek] Validation error:',
      error instanceof Error ? error.message : 'Unknown error',
    )
    return {
      valid: false,
      error: error instanceof AxiosError ? error.message : 'Connection failed',
    }
  }
}
