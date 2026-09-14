/**
 * In-process event bus used to fan out backend push events (proxy status,
 * config changes, new logs, OAuth progress, ...) to connected web clients.
 */

import { EventEmitter } from 'events'

export const appEventBus = new EventEmitter()
appEventBus.setMaxListeners(0)

export interface AppEvent {
  channel: string
  payload: unknown
}

export function emitToClients(channel: string, payload: unknown): void {
  appEventBus.emit('event', { channel, payload } satisfies AppEvent)
}

export function subscribeToEvents(listener: (event: AppEvent) => void): () => void {
  appEventBus.on('event', listener)
  return () => appEventBus.off('event', listener)
}
