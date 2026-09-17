/**
 * Local-timezone day helpers.
 *
 * Daily statistics used to key "today" off `toISOString()` (UTC), which made
 * the daily rollover happen at UTC midnight (e.g. 08:00 in UTC+8) instead of
 * the user's local midnight. These helpers make every day boundary local.
 */

/** Local-timezone `YYYY-MM-DD` key for the given instant. */
export function localDateKey(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Epoch milliseconds at the start of the local day containing `date`. */
export function localDayStart(date: Date = new Date()): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * Epoch milliseconds at the start of the local day `offsetDays` away from
 * `from` (negative moves into the past). Delegates to the Date constructor so
 * it stays correct across DST transitions instead of adding fixed 24h spans.
 */
export function localDayStartOffset(offsetDays: number, from: Date = new Date()): number {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + offsetDays).getTime()
}

/** Local `YYYY-MM-DD` key for the day `offsetDays` away from `from`. */
export function localDateKeyOffset(offsetDays: number, from: Date = new Date()): string {
  return localDateKey(new Date(from.getFullYear(), from.getMonth(), from.getDate() + offsetDays))
}
