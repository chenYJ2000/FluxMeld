/**
 * FluxMeld headless server entry point.
 *
 * Runs the full application (storage, IPC handlers, proxy service) in plain
 * Node without Electron, and serves the web UI over the LAN.
 *
 * Environment variables:
 *   WEB_HOST (default 0.0.0.0)          Bind host for the web UI
 *   WEB_PORT (default 3000)             Bind port for the web UI
 *   WEB_ACCESS_PASSWORD                 Optional access password (default: none)
 *   FLUXMELD_DATA_DIR (default ~/.fluxmeld)
 *   FLUXMELD_RENDERER_DIR               Built renderer directory
 *   FLUXMELD_BRIDGE_PATH                Built bridge script path
 */

// Must be set before any management route handles a request.
process.env.FLUXMELD_MANAGEMENT_AUTH_BYPASS = process.env.FLUXMELD_MANAGEMENT_AUTH_BYPASS || '1'

import { ipcMain, registerWebWindow } from './stubs/electron'
import { registerIpcHandlers } from '../main/ipc/handlers'
import { IpcChannels } from '../main/ipc/channels'
import { storeManager } from '../main/store/store'
import { emitToClients } from './eventBus'
import { startWebServer } from './webServer'

const WEB_HOST = process.env.WEB_HOST || '0.0.0.0'
const WEB_PORT = Number(process.env.WEB_PORT || 3000)
const ACCESS_PASSWORD = process.env.WEB_ACCESS_PASSWORD || undefined

function createHeadlessWindow() {
  return {
    webContents: {
      send: (channel: string, payload: unknown) => emitToClients(channel, payload),
      on: () => {},
      once: () => {},
      isDestroyed: () => false,
    },
    minimize: () => {},
    maximize: () => {},
    unmaximize: () => {},
    isMaximized: () => false,
    isMinimized: () => false,
    restore: () => {},
    hide: () => {},
    show: () => {},
    focus: () => {},
    close: () => {},
    isDestroyed: () => false,
  }
}

async function main(): Promise<void> {
  const headlessWindow = createHeadlessWindow()
  registerWebWindow(headlessWindow)

  await storeManager.initialize()

  const initialConfig = storeManager.getConfig()
  if (!initialConfig.proxyHost || initialConfig.proxyHost === '127.0.0.1' || initialConfig.proxyHost === 'localhost') {
    storeManager.updateConfig({ proxyHost: '0.0.0.0' })
    console.log('[web] proxy host set to 0.0.0.0 for LAN access')
  }

  await registerIpcHandlers(headlessWindow as any)

  // In-app browser OAuth requires Electron; degrade to manual token entry.
  const inAppLoginUnavailable = async (_event: unknown, payload?: { providerId?: string }) => ({
    success: false,
    providerId: payload?.providerId || '',
    error:
      'In-app browser login is not available in web mode. Please log in through the provider website and paste the token manually.',
  })
  ipcMain.handle(IpcChannels.OAUTH_START_IN_APP_LOGIN, inAppLoginUnavailable)
  ipcMain.handle(IpcChannels.OAUTH_CANCEL_IN_APP_LOGIN, async () => {})
  ipcMain.handle(IpcChannels.OAUTH_IN_APP_LOGIN_STATUS, async () => false)

  const proxyPort = storeManager.getConfig().proxyPort

  await startWebServer({
    host: WEB_HOST,
    port: WEB_PORT,
    proxyPort,
    accessPassword: ACCESS_PASSWORD,
  })

  console.log('[web] proxy service port:', proxyPort)
  if (ACCESS_PASSWORD) {
    console.log('[web] access password protection is enabled')
  }
}

main().catch((error) => {
  console.error('[web] failed to start FluxMeld server:', error)
  process.exit(1)
})
