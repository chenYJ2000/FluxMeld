import type { Account, Provider } from '../../../shared/types'
import type { TokenCheckResult } from '../types'

export function checkPerplexityToken(
  _provider: Provider,
  account: Account,
): TokenCheckResult {
  const sessionToken = account.credentials.sessionToken || account.credentials.token

  if (!sessionToken) {
    return { valid: false, error: 'Session token is required' }
  }

  if (sessionToken.length < 100) {
    return { valid: false, error: 'Session token appears to be invalid (too short)' }
  }

  return {
    valid: true,
    userInfo: {
      name: 'Perplexity User',
    },
  }
}
