import type { Account } from '../../../shared/types'
import { storeManager } from '../../store/store'
import { egressManager } from '../../egress/manager'
import { runWithEgress } from '../../egress/context'
import { getQwenAiJwtExpiry, normalizeQwenAiCredentials, resolveQwenAiCredentials } from './session'

export function needsQwenAiBackgroundRefresh(
  account: Account,
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (account.status !== 'active' || account.enabled === false) return false
  const credentials = normalizeQwenAiCredentials(account.credentials)
  if (!credentials.refresh_token) return false
  const accessToken = credentials.token || credentials.accessToken || credentials.apiKey || ''
  const accessExpiry = getQwenAiJwtExpiry(accessToken)
  const refreshExpiry = getQwenAiJwtExpiry(credentials.refresh_token)
  return (
    !accessToken ||
    (accessExpiry !== null && accessExpiry <= now + 10 * 60) ||
    (refreshExpiry !== null && refreshExpiry <= now + 24 * 60 * 60)
  )
}

export async function maintainQwenAiSessions(): Promise<void> {
  const accounts = storeManager
    .getAccountsByProviderId('qwen-ai', true)
    .filter((account) => needsQwenAiBackgroundRefresh(account))
  for (let index = 0; index < accounts.length; index += 3) {
    await Promise.all(
      accounts.slice(index, index + 3).map(async (account) => {
        try {
          const exit = await egressManager.resolveExitForAccount(account.providerId, account.id)
          await runWithEgress(exit, () => resolveQwenAiCredentials(account, { force: true }))
        } catch (error) {
          console.warn('[QwenAI] Background session maintenance failed', {
            accountId: account.id,
            message: error instanceof Error ? error.message : 'Unknown error',
          })
        }
      }),
    )
  }
}
