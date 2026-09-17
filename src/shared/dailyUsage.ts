import type { Account } from './types'
import { localDateKey } from './date'

type DailyUsageCarrier = Pick<Account, 'todayUsed' | 'todayUsedDate'>

/**
 * Effective "used today" for an account. A usage count stamped with an older
 * day is treated as 0 so stale counters never keep an account rate-limited
 * after the local day rolls over.
 */
export function effectiveTodayUsed(account: DailyUsageCarrier, now: Date = new Date()): number {
  if (!account.todayUsed) return 0
  return account.todayUsedDate === localDateKey(now) ? account.todayUsed : 0
}

/** Usage counters after one more successful request, resetting on a new day. */
export function incrementTodayUsed(
  account: DailyUsageCarrier,
  now: Date = new Date(),
): { todayUsed: number; todayUsedDate: string } {
  const date = localDateKey(now)
  const used = account.todayUsedDate === date ? (account.todayUsed || 0) : 0
  return { todayUsed: used + 1, todayUsedDate: date }
}
