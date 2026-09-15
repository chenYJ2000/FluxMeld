/**
 * OAuth credential normalization.
 *
 * Providers whose OAuth flow returns credentials under non-canonical keys
 * declare a `normalizeOAuthCredentials` function on their module. This helper
 * applies it so the renderer always receives canonical credential keys and no
 * longer needs provider-specific mapping logic.
 */

import type { OAuthResult } from '../oauth/types'
import { getProviderModule } from './registry'

export function normalizeOAuthCredentials(
  providerId: string | undefined,
  credentials: Record<string, string> | undefined,
): Record<string, string> {
  if (!credentials) return {}
  const normalize = providerId
    ? getProviderModule(providerId)?.normalizeOAuthCredentials
    : undefined
  return normalize ? normalize(credentials) : credentials
}

export function normalizeOAuthResult(
  providerId: string | undefined,
  result: OAuthResult,
): OAuthResult {
  if (!result?.success || !result.credentials) return result
  return {
    ...result,
    credentials: normalizeOAuthCredentials(providerId, result.credentials),
  }
}
