/**
 * Clash/mihomo node table parsing.
 *
 * Returns the full `/proxies` table in its original order. Policy groups,
 * DIRECT/REJECT/PASS and subscription banners are kept in the table but marked
 * `selectable: false`, so the selection scan can count them as candidates while
 * never trying them. Dead nodes (`alive === false`) are kept and marked so they
 * can be skipped without consuming candidate budget.
 */

export interface ClashProxyEntry {
  type?: string
  alive?: boolean
  history?: Array<{ delay?: number }>
}

export interface ClashNodeTableEntry {
  name: string
  selectable: boolean
  alive: boolean
  delay: number
}

const POLICY_GROUP_TYPES = new Set(['selector', 'urltest', 'fallback', 'loadbalance'])
const NON_NODE_TYPES = new Set(['compatible', 'pass', 'reject', 'rejectdrop', 'direct'])
const BANNER_PATTERN = /^(剩余流量|套餐到期|过滤掉\d+条线路)/

export function parseClashNodeTable(
  allProxies: Record<string, ClashProxyEntry | undefined>,
): ClashNodeTableEntry[] {
  const entries: ClashNodeTableEntry[] = []

  for (const [name, entry] of Object.entries(allProxies)) {
    if (!entry) continue
    const type = (entry.type ?? '').toLowerCase()
    if (type.length === 0) continue

    const selectable =
      !POLICY_GROUP_TYPES.has(type) &&
      !NON_NODE_TYPES.has(type) &&
      name !== 'DIRECT' &&
      name !== 'REJECT' &&
      name !== 'PASS' &&
      !BANNER_PATTERN.test(name)

    const alive = entry.alive !== false
    const delay =
      entry.history && entry.history[0]?.delay ? entry.history[0].delay : Number.MAX_SAFE_INTEGER

    entries.push({ name, selectable, alive, delay })
  }

  return entries
}
