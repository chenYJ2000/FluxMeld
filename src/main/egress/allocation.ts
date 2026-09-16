/**
 * Global exit allocator.
 *
 * Hands out exits from a source's pool using a single monotonic cursor:
 *   - each allocation advances the cursor, so the next group never receives the
 *     exit the previous group just released or currently holds;
 *   - already-in-use exits are skipped while unused ones remain;
 *   - once the pool is saturated, allocation wraps around and reuses exits
 *     ("占满就环绕复用").
 */

import type { EgressExit } from './types'

export class ExitAllocator {
  private cursor = 0
  private readonly inUse = new Set<string>()

  allocate(pool: EgressExit[]): EgressExit | null {
    if (pool.length === 0) return null

    for (let step = 0; step < pool.length; step++) {
      const index = (this.cursor + step) % pool.length
      const exit = pool[index]
      if (!this.inUse.has(exit.id)) {
        this.cursor = (index + 1) % pool.length
        this.inUse.add(exit.id)
        return exit
      }
    }

    // Saturated: wrap and reuse.
    const index = this.cursor % pool.length
    this.cursor = (index + 1) % pool.length
    return pool[index]
  }

  release(exitId: string): void {
    this.inUse.delete(exitId)
  }

  markInUse(exitId: string): void {
    this.inUse.add(exitId)
  }

  isInUse(exitId: string): boolean {
    return this.inUse.has(exitId)
  }

  /** Current cursor position within the exit table. */
  position(): number {
    return this.cursor
  }

  /** Move the cursor (used by the table-scan selection algorithm). */
  setPosition(index: number): void {
    this.cursor = index
  }

  getInUse(): string[] {
    return [...this.inUse]
  }

  reset(): void {
    this.cursor = 0
    this.inUse.clear()
  }
}
