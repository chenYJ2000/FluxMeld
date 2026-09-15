/**
 * App lifecycle state.
 *
 * Tracks whether the application is in the process of quitting so that window
 * "close" handlers can distinguish a real quit from a minimize-to-tray request.
 * Kept in a module instead of monkey-patching Electron's `App` object.
 */

let quitting = false

export function markAppQuitting(): void {
  quitting = true
}

export function isAppQuitting(): boolean {
  return quitting
}

export function resetAppQuitting(): void {
  quitting = false
}
