/**
 * Headless no-op replacement for `electron-updater`.
 *
 * The updater is a desktop-only concern; in the server build every operation is
 * a no-op so the imported `UpdaterManager` can be constructed without Electron.
 */

import { EventEmitter } from 'events'

export type UpdateInfo = Record<string, unknown>

class NoopAutoUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  allowPrerelease = false
  allowDowngrade = false
  currentVersion = { version: '0.0.0' }
  logger: unknown = null

  setFeedURL(): void {}
  checkForUpdates(): Promise<null> {
    return Promise.resolve(null)
  }
  downloadUpdate(): Promise<string[]> {
    return Promise.resolve([])
  }
  quitAndInstall(): void {}
}

export const autoUpdater = new NoopAutoUpdater()

export default { autoUpdater }
