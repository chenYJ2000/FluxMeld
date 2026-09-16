/**
 * Expiry-aware rotation scheduler.
 *
 * Schedules a rotation a fixed number of seconds before an exit expires (used
 * by lifetime-bound sources such as IP pools). Currently unused by the built-in
 * sources but part of the shared rotation toolkit so future sources can opt in.
 */

export class RotationScheduler {
  private timer: NodeJS.Timeout | null = null

  /**
   * Schedule `onRotate` to fire `earlySeconds` before `expiresAt`.
   * Passing a falsy `expiresAt` cancels any pending rotation.
   */
  schedule(expiresAt: number | undefined, earlySeconds: number, onRotate: () => void): void {
    this.cancel()
    if (!expiresAt) return

    const delay = Math.max(0, expiresAt - earlySeconds * 1000 - Date.now())
    this.timer = setTimeout(() => {
      this.timer = null
      onRotate()
    }, delay)
    this.timer.unref?.()
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  isScheduled(): boolean {
    return this.timer !== null
  }
}
