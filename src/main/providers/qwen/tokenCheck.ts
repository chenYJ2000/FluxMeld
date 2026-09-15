import axios, { AxiosError } from 'axios'
import type { Account, Provider } from '../../../shared/types'
import type { TokenCheckResult } from '../types'

const CHECK_TIMEOUT = 15000

export async function checkQwenToken(
  _provider: Provider,
  account: Account,
): Promise<TokenCheckResult> {
  const ticket = account.credentials.ticket

  try {
    const response = await axios.post(
      'https://chat2-api.qianwen.com/api/v2/session/page/list',
      {},
      {
        headers: {
          Cookie: `tongyi_sso_ticket=${ticket}`,
          'Content-Type': 'application/json',
          Accept: '*/*',
          Origin: 'https://www.qianwen.com',
          Referer: 'https://www.qianwen.com/',
          'X-Platform': 'pc_tongyi',
          'X-DeviceId': '5b68c267-cd8e-fd0e-148a-18345bc9a104',
        },
        params: {
          biz_id: 'ai_qwen',
          chat_client: 'h5',
          device: 'pc',
          fr: 'pc',
          pr: 'qwen',
          ut: '5b68c267-cd8e-fd0e-148a-18345bc9a104',
        },
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      },
    )

    if (response.status === 200 && response.data?.success) {
      return {
        valid: true,
      }
    }

    if (!response.data?.success) {
      return { valid: false, error: 'SSO ticket expired or invalid' }
    }

    return {
      valid: false,
      error: `Validation failed: ${response.data?.errorMsg || 'Unknown error'}`,
    }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof AxiosError ? error.message : 'Connection failed',
    }
  }
}
