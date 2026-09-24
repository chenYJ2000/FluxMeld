/**
 * Kimi token helpers
 *
 * Kimi web auth supports two token forms:
 * - JWT access tokens (start with "eyJ"), sent as `Authorization: Bearer`
 * - Opaque "v10" session tokens (the base64 value stored in the kimi-auth
 *   cookie), sent as `Cookie: kimi-auth=<token>`. The server rejects opaque
 *   tokens sent via Bearer with "token is malformed".
 */

const OPAQUE_TOKEN_PREFIX = 'v10'

/** JWT expiry is distinct from the browser's Cookie expiration date. */
export function getKimiJwtExpiry(token: string): number | null {
  const parts = token.trim().split('.')
  if (parts.length !== 3 || !parts[0].startsWith('eyJ')) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null
  } catch {
    return null
  }
}

export function isKimiOpaqueToken(token: string): boolean {
  const trimmed = token.trim()
  if (!trimmed) return false
  if (trimmed.startsWith(OPAQUE_TOKEN_PREFIX)) return true
  if (trimmed.startsWith('eyJ')) return false

  // The cookie stores the base64 form of the opaque token; base64("v10") = "djEw"
  if (!/^[A-Za-z0-9+/=]+$/.test(trimmed)) return false
  try {
    const decoded = Buffer.from(trimmed, 'base64')
    return decoded.length >= 3 && decoded.subarray(0, 3).toString('utf8') === OPAQUE_TOKEN_PREFIX
  } catch {
    return false
  }
}

export function buildKimiAuthHeaders(token: string): Record<string, string> {
  if (isKimiOpaqueToken(token)) {
    return { Cookie: `kimi-auth=${token.trim()}` }
  }
  return { Authorization: `Bearer ${token.trim()}` }
}
