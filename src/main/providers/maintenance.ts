import { getProviderModules } from './registry'

const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000

export function startProviderSessionMaintenance(): () => void {
  let running = false

  const run = async () => {
    if (running) return
    running = true
    try {
      await Promise.all(
        getProviderModules().map(async (module) => {
          if (!module.maintainSessions) return
          try {
            await module.maintainSessions()
          } catch (error) {
            console.warn(`[${module.id}] Session maintenance failed:`, error)
          }
        }),
      )
    } finally {
      running = false
    }
  }

  void run()
  const timer = setInterval(() => void run(), MAINTENANCE_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
