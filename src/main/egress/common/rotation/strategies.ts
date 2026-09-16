/**
 * Exit ordering strategies.
 *
 * The manager owns the allocation cursor; these helpers only decide a preferred
 * order over the source's exit pool. Sources may ignore them and return an
 * already-ranked list (Clash ranks alive/low-latency nodes first).
 */

import type { ExitPoolEntry } from './ExitPool'
import type { EgressExit } from '../../types.ts'

export type RotationStrategyId = 'roundRobin' | 'lowestLatency' | 'random'

function shuffle<T>(items: T[]): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/** Return exits ordered according to the requested strategy. */
export function orderExits(entries: ExitPoolEntry[], strategy: RotationStrategyId): EgressExit[] {
  if (strategy === 'random') {
    return shuffle(entries.map((entry) => entry.exit))
  }

  if (strategy === 'lowestLatency') {
    const ranked = [...entries].sort((a, b) => {
      const aAlive = a.alive !== false
      const bAlive = b.alive !== false
      if (aAlive !== bAlive) return aAlive ? -1 : 1
      const aLatency = a.latency ?? Number.MAX_SAFE_INTEGER
      const bLatency = b.latency ?? Number.MAX_SAFE_INTEGER
      return aLatency - bLatency
    })
    return ranked.map((entry) => entry.exit)
  }

  return entries.map((entry) => entry.exit)
}
