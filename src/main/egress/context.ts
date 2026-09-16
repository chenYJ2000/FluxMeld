/**
 * Request-scoped egress context.
 *
 * The forwarder wraps each upstream attempt in `runWithEgress(exit, fn)` so the
 * axios interceptor can inject the correct proxy per request without mutating
 * global defaults. This is what makes concurrent accounts use different exits.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { EgressExit } from './types'

const storage = new AsyncLocalStorage<EgressExit | null>()

/** Run `fn` with `exit` as the effective outbound proxy (null = direct). */
export function runWithEgress<T>(exit: EgressExit | null, fn: () => T): T {
  return storage.run(exit, fn)
}

/** The exit bound to the current async execution, or null when direct. */
export function getCurrentEgress(): EgressExit | null {
  return storage.getStore() ?? null
}
