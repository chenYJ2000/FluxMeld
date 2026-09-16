/**
 * Ordered pool of exits exposed by an egress source.
 *
 * Tracks per-exit health so rotation strategies can rank recovered/dead exits
 * without dropping them (a dead exit can come back later).
 */

import type { EgressExit } from '../../types.ts'

export interface ExitPoolEntry {
  exit: EgressExit
  failures: number
  lastFailureAt: number
  /** Observed latency in ms, when known. */
  latency?: number
  /** Source-reported liveness; undefined = unknown. */
  alive?: boolean
}

export class ExitPool {
  private entries: ExitPoolEntry[] = []

  constructor(exits: EgressExit[] = []) {
    this.setExits(exits)
  }

  /** Replace the pool, preserving health stats for exits that persist. */
  setExits(exits: EgressExit[]): void {
    const previous = new Map(this.entries.map((entry) => [entry.exit.id, entry]))
    this.entries = exits.map((exit) => {
      const prior = previous.get(exit.id)
      return {
        exit,
        failures: prior?.failures ?? 0,
        lastFailureAt: prior?.lastFailureAt ?? 0,
        latency: prior?.latency,
        alive: prior?.alive,
      }
    })
  }

  getEntries(): ExitPoolEntry[] {
    return this.entries
  }

  getExits(): EgressExit[] {
    return this.entries.map((entry) => entry.exit)
  }

  markFailure(exitId: string): void {
    const entry = this.entries.find((item) => item.exit.id === exitId)
    if (!entry) return
    entry.failures += 1
    entry.lastFailureAt = Date.now()
    entry.alive = false
  }

  clearFailure(exitId: string): void {
    const entry = this.entries.find((item) => item.exit.id === exitId)
    if (!entry) return
    entry.failures = 0
    entry.alive = true
  }

  size(): number {
    return this.entries.length
  }
}
