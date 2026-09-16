/**
 * Shared egress exit verification.
 *
 * Probes an exit end-to-end by issuing a lightweight HTTPS request through it.
 * A proxy-level failure surfaces as an exception; any HTTP response (even 4xx)
 * means the exit actually reached the target.
 */

import axios from 'axios'
import { buildAxiosProxyConfig } from '../http'
import type { EgressExit } from '../types'

export const DEFAULT_VERIFY_URL = 'https://www.gstatic.com/generate_204'

export interface VerifyOptions {
  timeoutMs?: number
  url?: string
}

export async function verifyExit(exit: EgressExit, options: VerifyOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 8000
  const url = options.url ?? DEFAULT_VERIFY_URL
  try {
    const response = await axios.get(url, {
      ...buildAxiosProxyConfig(exit),
      timeout: timeoutMs,
      validateStatus: () => true,
      maxRedirects: 0,
    })
    return response.status >= 200 && response.status < 600
  } catch {
    return false
  }
}
