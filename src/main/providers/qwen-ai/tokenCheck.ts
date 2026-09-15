import axios, { AxiosError } from 'axios'
import type { Account, Provider } from '../../../shared/types'
import type { TokenCheckResult } from '../types'

const CHECK_TIMEOUT = 15000

export async function checkQwenAiToken(
  _provider: Provider,
  account: Account,
): Promise<TokenCheckResult> {
  const token = account.credentials.token

  try {
    const response = await axios.get('https://chat.qwen.ai/api/v2/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        source: 'web',
      },
      timeout: CHECK_TIMEOUT,
      validateStatus: () => true,
    })

    if (response.status === 200 && response.data?.data) {
      return {
        valid: true,
        userInfo: {
          name: response.data.data.name || response.data.data.email,
          email: response.data.data.email,
        },
      }
    }

    if (response.status === 401) {
      return { valid: false, error: 'Token expired or invalid' }
    }

    return { valid: false, error: `Validation failed: HTTP ${response.status}` }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof AxiosError ? error.message : 'Connection failed',
    }
  }
}
