/**
 * Headless replacement for `electron-store`.
 *
 * Implements the small surface the app relies on (`get`, `set`, `has`, `delete`,
 * `clear`, `store`) on top of a plain JSON file so the server can run without
 * Electron. The constructor accepts the same options object shape that
 * `store.ts` passes to electron-store; the optional `encryptionKey` is ignored
 * because credential-level encryption is handled separately.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

export interface ElectronStoreOptions<T> {
  name?: string
  cwd?: string
  defaults?: T
  encryptionKey?: string
  clearInvalidConfig?: boolean
  fileExtension?: string
}

export default class ElectronStore<T extends Record<string, unknown>> {
  private filePath: string
  private data: T

  constructor(options: ElectronStoreOptions<T> = {}) {
    const name = options.name || 'config'
    const cwd = options.cwd || process.cwd()
    const extension = (options.fileExtension || 'json').replace(/^\./, '')
    this.filePath = join(cwd, `${name}.${extension}`)
    this.data = this.load(options.defaults || ({} as T))
  }

  private load(defaults: T): T {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8')
        if (raw.trim()) {
          const parsed = JSON.parse(raw) as T
          return { ...defaults, ...parsed }
        }
      }
    } catch (error) {
      console.error('[Store] Failed to read store file, falling back to defaults:', error)
    }
    return { ...defaults }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
      renameSync(tmp, this.filePath)
    } catch (error) {
      console.error('[Store] Failed to persist store file:', error)
    }
  }

  get<K extends keyof T>(key: K): T[K]
  get<K extends keyof T>(key: K, defaultValue: T[K]): T[K]
  get(key: string): unknown
  get(key: string, defaultValue?: unknown): unknown {
    const value = (this.data as Record<string, unknown>)[key]
    return value === undefined ? defaultValue : value
  }

  set(key: string | Partial<T>, value?: unknown): void {
    if (typeof key === 'object' && key !== null) {
      Object.assign(this.data, key)
    } else {
      ;(this.data as Record<string, unknown>)[key] = value
    }
    this.persist()
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data, key)
  }

  delete(key: string): void {
    delete (this.data as Record<string, unknown>)[key]
    this.persist()
  }

  clear(): void {
    this.data = {} as T
    this.persist()
  }

  get store(): T {
    return this.data
  }

  set store(value: T) {
    this.data = value
    this.persist()
  }
}
