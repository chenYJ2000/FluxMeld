/**
 * Shared outbound proxy discovery helpers.
 *
 * These are provider-agnostic primitives shared by egress sources (and the
 * manager) so each source does not re-implement env parsing or TCP probing.
 */

import net from 'net'

const PROXY_ENV_NAMES = [
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
  'all_proxy',
  'ALL_PROXY',
] as const

export interface DiscoveredProxy {
  host: string
  port: number
  source: string
}

/** Parse an "http://host:port" style proxy URL (scheme optional). */
export function parseProxyUrl(value: string): { host: string; port: number } | null {
  if (!value) return null
  let url: URL
  try {
    url =
      value.startsWith('http://') || value.startsWith('https://')
        ? new URL(value)
        : new URL(`http://${value}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port ? Number(url.port) : 80
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host: url.hostname, port }
}

/** Discover local HTTP proxies declared through the process environment. */
export function discoverEnvProxies(): DiscoveredProxy[] {
  const results: DiscoveredProxy[] = []
  const seen = new Set<string>()

  for (const name of PROXY_ENV_NAMES) {
    const value = process.env[name]
    if (!value) continue
    const parsed = parseProxyUrl(value)
    if (!parsed) continue
    const key = `${parsed.host}:${parsed.port}`
    if (seen.has(key)) continue
    seen.add(key)
    results.push({ ...parsed, source: `env:${name}` })
  }

  return results
}

/** Probe whether a TCP connection to host:port succeeds within the timeout. */
export function canTcpConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host)
    const finish = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => finish(true))
    socket.on('error', () => finish(false))
    socket.on('timeout', () => finish(false))
  })
}

/** First local port from `ports` that accepts a TCP connection, or null. */
export async function probeLocalPorts(
  ports: readonly number[],
  host: string,
  timeoutMs: number,
): Promise<number | null> {
  for (const port of ports) {
    if (await canTcpConnect(host, port, timeoutMs)) return port
  }
  return null
}
