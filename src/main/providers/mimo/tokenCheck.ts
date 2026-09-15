import type { Account, Provider } from '../../../shared/types'
import type { TokenCheckResult } from '../types'

export function checkMimoToken(_provider: Provider, account: Account): TokenCheckResult {
  const serviceToken = account.credentials.service_token
  const userId = account.credentials.user_id
  const phToken = account.credentials.ph_token

  if (!serviceToken || !userId || !phToken) {
    return {
      valid: false,
      error: 'Missing required credentials: service_token, user_id, ph_token',
    }
  }

  return {
    valid: true,
    userInfo: {
      name: 'Mimo User',
    },
  }
}
