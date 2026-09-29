import { checkQwenAiCredentials } from './auth'
import type { Account, Provider } from '../../../shared/types'
import type { TokenCheckResult } from '../types'
import { resolveQwenAiCredentials } from './session'

export async function checkQwenAiToken(
  _provider: Provider,
  account: Account,
): Promise<TokenCheckResult> {
  try {
    let credentials = await resolveQwenAiCredentials(account)
    let result = await checkQwenAiCredentials(credentials)
    if (
      !result.valid &&
      credentials.refresh_token &&
      /expired|invalid|session/i.test(result.error || '')
    ) {
      credentials = await resolveQwenAiCredentials(account, {
        force: true,
        failedToken: credentials.token,
      })
      result = await checkQwenAiCredentials(credentials)
    }
    return result
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : 'Qwen 自动续期失败' }
  }
}
