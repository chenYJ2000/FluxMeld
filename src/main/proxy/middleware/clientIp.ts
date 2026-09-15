/**
 * Client source-IP resolution for inbound proxy requests.
 *
 * Pure helpers (no imports) so both the Electron main proxy and the headless
 * web server can use them.
 */

/**
 * Resolve the client source IP.
 *
 * Trust model:
 * - A non-loopback TCP peer is always authoritative: headers are ignored so a
 *   client cannot forge `X-Forwarded-For`.
 * - On a loopback peer the supplied `forwardedFor` list is the only way real
 *   clients are distinguishable, but attacker-forged entries always sit on the
 *   LEFT of the list because every real hop appends what IT saw. Walking from
 *   the right therefore never returns an attacker-controlled value:
 *   - loopback segments are appends made by local relays (FluxMeld web server,
 *     same-host nginx) and are skipped automatically;
 *   - `trustedProxyHops` additional non-loopback segments may be skipped if the
 *     deployment has remote trusted proxies (remote nginx/frp).
 * - When nothing trustworthy remains, the raw socket address is returned so the
 *   log never shows a fabricated IP.
 *
 * @param socketAddress peer address of the TCP connection as received
 * @param forwardedFor raw `X-Forwarded-For` header value (or '')
 * @param trustedProxyHops remote trusted-proxy hops to additionally skip
 */
export function resolveClientIp(
  socketAddress: string | undefined,
  forwardedFor: string | undefined,
  trustedProxyHops: number,
): string {
  const socket = normalizeIp(socketAddress)
  if (!socket) return 'unknown'

  if (!isLoopbackIp(socket)) {
    return socket
  }

  const segments = (forwardedFor || '')
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)

  let remaining = Math.max(0, Math.floor(trustedProxyHops))
  for (let i = segments.length; i > 0; i--) {
    const segment = normalizeIp(segments[i - 1])
    if (!segment) continue
    if (isLoopbackIp(segment)) continue
    if (remaining > 0) {
      remaining--
      continue
    }
    return segment
  }

  return socket
}

export function isLoopbackIp(ip: string): boolean {
  return ['127.0.0.1', '::1'].includes(normalizeIp(ip) || '')
}

export function normalizeIp(value: string | undefined): string {
  if (!value) return ''
  let ip = value.trim().slice(0, 64)
  const colonPort = ip.lastIndexOf(']:')
  if (ip.startsWith('[') && colonPort !== -1) {
    ip = ip.slice(1, colonPort)
  }
  if (ip.includes('%')) {
    ip = ip.split('%')[0]
  }
  return ip
}
