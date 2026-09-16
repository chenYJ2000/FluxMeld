/**
 * Egress subsystem bootstrap.
 *
 * Installs the per-request axios proxy interceptor and wires the manager to the
 * store. Called once from the main process / headless server entry points.
 */

import { installDefaultEgressInterceptor } from './http.ts'
import { egressManager, type OutboundProxySettings } from './manager.ts'

let initialized = false

export async function initializeEgress(): Promise<void> {
  if (initialized) return
  initialized = true

  installDefaultEgressInterceptor()

  const { storeManager } = await import('../store/store.ts')

  egressManager.setDeps({
    getSettings: () => storeManager.getConfig().outboundProxy as OutboundProxySettings,
    getProviderAssignment: (providerId) =>
      storeManager.getProviderById(providerId)?.proxyAssignment,
    getAccountIds: (providerId) =>
      storeManager.getAccountsByProviderId(providerId).map((account) => account.id),
    listProviderIds: () => storeManager.getProviders().map((provider) => provider.id),
    getProviderName: (providerId) => storeManager.getProviderById(providerId)?.name ?? '',
    logger: {
      info: (message) => storeManager.addLog('info', message),
      warn: (message) => storeManager.addLog('warn', message),
    },
  })

  try {
    const settings = storeManager.getConfig().outboundProxy
    if (settings?.enabled) {
      // Activate on startup (single-exit mode enters proxy mode; group mode is
      // activated lazily per request). Leased sources may block until an exit
      // is available, so this must not block app startup.
      void egressManager.enable().catch(() => {
        // Startup should never fail because egress could not be prepared.
      })
    }
  } catch {
    // Startup should never fail because egress could not be prepared.
  }
}

export { egressManager } from './manager.ts'
export { runWithEgress, getCurrentEgress } from './context.ts'
export { getEgressSourceMetas, getEgressSourceModules } from './registry.ts'
