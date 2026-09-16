/**
 * Clash/mihomo node filtering.
 *
 * Keeps the real proxy nodes from a `/proxies` payload, sorted so alive nodes
 * (health-check OK) with the lowest latency come first. Dead nodes are kept but
 * ranked last so they can recover. DIRECT/REJECT, traffic banners and policy
 * groups are excluded.
 */

export interface ClashProxyEntry {
  type?: string
  alive?: boolean
  history?: Array<{ delay?: number }>
}

export function filterRealClashNodes(
  allProxies: Record<string, ClashProxyEntry | undefined>,
): string[] {
  const policyGroupTypes = new Set(['selector', 'urltest', 'fallback', 'loadbalance'])
  const nonNodeTypes = new Set(['compatible', 'pass', 'reject', 'rejectdrop', 'direct'])
  const nodes: Array<{ name: string; alive: boolean; delay: number }> = []

  for (const [name, entry] of Object.entries(allProxies)) {
    if (!entry) continue
    const type = (entry.type ?? '').toLowerCase()
    if (type.length === 0) continue
    if (policyGroupTypes.has(type)) continue
    if (nonNodeTypes.has(type)) continue
    if (name === 'DIRECT' || name === 'REJECT' || name === 'PASS') continue
    if (/^(剩余流量|套餐到期|过滤掉\d+条线路)/.test(name)) continue
    const alive = entry.alive !== false
    const delay =
      entry.history && entry.history[0]?.delay ? entry.history[0].delay : Number.MAX_SAFE_INTEGER
    nodes.push({ name, alive, delay })
  }

  nodes.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1
    return a.delay - b.delay
  })
  return nodes.map((n) => n.name)
}
