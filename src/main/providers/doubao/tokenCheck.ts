import { DoubaoAdapter } from './adapter'
import type { Account, Provider } from '../../../shared/types'
import type { TokenCheckResult } from '../types'

/**
 * Validate a Doubao account.
 *
 * Doubao's session endpoint has no cheap read-only probe, so this verifies the
 * captured credential bundle is complete and well-formed. A real request would
 * consume one of the session's conversations.
 */
export async function checkDoubaoToken(
  _provider: Provider,
  account: Account,
): Promise<TokenCheckResult> {
  const missing = DoubaoAdapter.missingCredentials(account.credentials)
  if (missing.length) {
    return { valid: false, error: `缺少必要凭据：${missing.join(', ')}` }
  }

  const cookie = String(account.credentials.cookies ?? '')
  if (!cookie.includes('=')) {
    return { valid: false, error: 'Cookie 内容无效，请粘贴完整的 Cookie 请求头' }
  }

  return { valid: true }
}
