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
