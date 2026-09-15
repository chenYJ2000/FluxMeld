/**
 * Browser-side bridge.
 *
 * Runs inside the web page and exposes a `window.electronAPI` object with the
 * same surface as the Electron preload, backed by HTTP (`/api/invoke`) and
 * Server-Sent Events (`/api/events`). This lets the existing renderer run
 * unchanged in a browser.
 */

import { createClientApi, type ClientTransport } from '../shared/clientApi'

type EventCallback = (...args: any[]) => void

const subscribers = new Map<string, Set<EventCallback>>()
let eventSource: EventSource | null = null

function dispatchEvent(channel: string, payload: unknown): void {
  const handlers = subscribers.get(channel)
  if (!handlers) return
  for (const handler of handlers) {
    try {
      handler(payload)
    } catch (error) {
      console.error(`[bridge] event handler failed for ${channel}:`, error)
    }
  }
}

function ensureEventSource(): void {
  if (eventSource || typeof EventSource === 'undefined') return
  eventSource = new EventSource('/api/events')
  eventSource.onmessage = (event) => {
    try {
      const parsed = JSON.parse(event.data) as { channel: string; payload: unknown }
      dispatchEvent(parsed.channel, parsed.payload)
    } catch (error) {
      console.error('[bridge] failed to parse event:', error)
    }
  }
  eventSource.onerror = () => {
    // EventSource reconnects automatically; keep the instance.
  }
}

const transport: ClientTransport = {
  async invoke(channel: string, ...args: unknown[]) {
    const response = await fetch('/api/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args }),
    })

    let payload: any = null
    try {
      payload = await response.json()
    } catch {
      // non-JSON response
    }

    if (!response.ok || !payload || payload.ok === false) {
      const message =
        payload?.error?.message || payload?.error || `Request failed (${response.status})`
      throw new Error(typeof message === 'string' ? message : 'Request failed')
    }

    return payload.data
  },

  on(channel: string, callback: EventCallback) {
    let handlers = subscribers.get(channel)
    if (!handlers) {
      handlers = new Set()
      subscribers.set(channel, handlers)
    }
    handlers.add(callback)
    ensureEventSource()

    return () => {
      handlers?.delete(callback)
      if (handlers && handlers.size === 0) {
        subscribers.delete(channel)
      }
    }
  },

  send(channel: string, ...args: unknown[]) {
    // One-way desktop channels (tray/window controls) are not applicable in web.
    console.debug(`[bridge] ignored send for channel: ${channel}`, args)
  },
}

const electronAPI = createClientApi(transport, { platform: 'web' })

;(window as any).electronAPI = electronAPI
