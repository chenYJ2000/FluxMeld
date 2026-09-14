/**
 * Headless `electron` shim used by the web/server bundle.
 *
 * The server reuses the existing main-process modules (IPC handlers, store,
 * adapters, OAuth adapters, tray/updater classes) without Electron installed at
 * runtime. This module provides just enough of the `electron` API surface for
 * those modules to load and execute in plain Node.
 *
 * - `ipcMain.handle/on` collects handlers so the web bridge can dispatch to them.
 * - `app` is backed by `~/.fluxmeld`.
 * - `safeStorage` is a no-op (storage is unencrypted).
 * - `net.request` is implemented with Node `http`/`https` (Perplexity adapter).
 */

import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import http from 'http'
import https from 'https'
import zlib from 'zlib'

const DATA_DIR = process.env.FLUXMELD_DATA_DIR || join(homedir(), '.fluxmeld')

function ensureDir(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

// ---------------------------------------------------------------------------
// ipcMain
// ---------------------------------------------------------------------------

type IpcHandler = (event: unknown, ...args: any[]) => unknown

class IpcMainShim extends EventEmitter {
  readonly handlers = new Map<string, IpcHandler>()

  handle(channel: string, listener: IpcHandler): void {
    this.handlers.set(channel, listener)
  }

  handleOnce(channel: string, listener: IpcHandler): void {
    this.handlers.set(channel, listener)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  hasHandler(channel: string): boolean {
    return this.handlers.has(channel)
  }

  async invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) {
      throw new Error(`No handler registered for channel: ${channel}`)
    }
    return handler({ channel }, ...args)
  }
}

export const ipcMain = new IpcMainShim()

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

class CommandLineShim {
  appendSwitch(): void {}
  appendArgument(): void {}
}

class AppShim extends EventEmitter {
  isPackaged = false
  isQuitting = false
  commandLine = new CommandLineShim()
  private version: string

  constructor() {
    super()
    this.version = readAppVersion()
  }

  getVersion(): string {
    return this.version
  }

  getName(): string {
    return 'FluxMeld'
  }

  getPath(name: string): string {
    if (name === 'userData' || name === 'appData' || name === 'sessionData') {
      return ensureDir(join(DATA_DIR, 'userData'))
    }
    if (name === 'logs') {
      return ensureDir(join(DATA_DIR, 'logs'))
    }
    if (name === 'temp') {
      return ensureDir(join(DATA_DIR, 'temp'))
    }
    return ensureDir(DATA_DIR)
  }

  getAppPath(): string {
    return process.env.FLUXMELD_ROOT || process.cwd()
  }

  setAppUserModelId(): void {}
  requestSingleInstanceLock(): boolean {
    return true
  }
  releaseSingleInstanceLock(): void {}
  quit(): void {}
  exit(): void {}
  relaunch(): void {}
  focus(): void {}
  show(): void {}
  whenReady(): Promise<void> {
    return Promise.resolve()
  }
  disableHardwareAcceleration(): void {}
}

function readAppVersion(): string {
  try {
    const pkgPath = join(process.env.FLUXMELD_ROOT || process.cwd(), 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const app = new AppShim()

// ---------------------------------------------------------------------------
// BrowserWindow / webContents
// ---------------------------------------------------------------------------

class WebContentsShim extends EventEmitter {
  send(_channel: string, ..._args: unknown[]): void {}
  executeJavaScript(): Promise<unknown> {
    return Promise.resolve(undefined)
  }
  isDestroyed(): boolean {
    return false
  }
  isDevToolsOpened(): boolean {
    return false
  }
  openDevTools(): void {}
  closeDevTools(): void {}
  toggleDevTools(): void {}
  setWindowOpenHandler(): void {}
  setZoomFactor(): void {}
  getURL(): string {
    return ''
  }
}

const windowRegistry: any[] = []

/**
 * Registers a headless window-like object so code paths that broadcast to
 * `BrowserWindow.getAllWindows()` (e.g. config change events) reach web clients.
 */
export function registerWebWindow(win: any): void {
  if (!windowRegistry.includes(win)) {
    windowRegistry.push(win)
  }
}

export function getRegisteredWindows(): any[] {
  return windowRegistry
}

export class BrowserWindow extends EventEmitter {
  webContents = new WebContentsShim()
  id = 0

  constructor(_options?: unknown) {
    super()
  }

  static getAllWindows(): BrowserWindow[] {
    return windowRegistry as BrowserWindow[]
  }

  loadURL(): Promise<void> {
    return Promise.resolve()
  }
  loadFile(): Promise<void> {
    return Promise.resolve()
  }
  show(): void {}
  hide(): void {}
  focus(): void {}
  close(): void {}
  destroy(): void {}
  minimize(): void {}
  maximize(): void {}
  unmaximize(): void {}
  restore(): void {}
  isMinimized(): boolean {
    return false
  }
  isMaximized(): boolean {
    return false
  }
  isDestroyed(): boolean {
    return false
  }
  setBounds(): void {}
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
}

// ---------------------------------------------------------------------------
// shell / session / screen / tray / menu / nativeImage
// ---------------------------------------------------------------------------

export const shell = {
  openExternal: async (_url: string): Promise<void> => {},
  openPath: async (): Promise<string> => '',
  showItemInFolder: (): void => {},
}

export class Session extends EventEmitter {
  cookies = {
    get: async () => [],
    set: async () => {},
    remove: async () => {},
    flushStore: async () => {},
  }
  webRequest = {
    onBeforeRequest: () => {},
    onBeforeSendHeaders: () => {},
    onHeadersReceived: () => {},
  }
  clearStorageData = async (): Promise<void> => {}
  setUserAgent = (): void => {}
}

export const session = {
  defaultSession: new Session(),
  fromPartition: (_partition: string): Session => new Session(),
}

export const screen = {
  getPrimaryDisplay: () => ({
    workAreaSize: { width: 1920, height: 1080 },
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  }),
  getAllDisplays: () => [],
}

export class Tray extends EventEmitter {
  constructor(_image?: unknown) {
    super()
  }
  setToolTip(): void {}
  setContextMenu(): void {}
  setImage(): void {}
  setTitle(): void {}
  destroy(): void {}
  on(): this {
    return this
  }
  focus(): void {}
}

class MenuItemShim {
  constructor(_options?: unknown) {}
}

export const Menu = {
  buildFromTemplate: (_template: unknown) => ({
    popup: () => {},
    items: [],
    append: () => {},
    insert: () => {},
  }),
  setApplicationMenu: () => {},
  getApplicationMenu: () => null,
}

export class MenuItem extends MenuItemShim {}
export type MenuItemConstructorOptions = Record<string, unknown>

class NativeImageShim {
  isEmpty(): boolean {
    return false
  }
  resize(): NativeImageShim {
    return this
  }
  toPNG(): Buffer {
    return Buffer.alloc(0)
  }
  toDataURL(): string {
    return ''
  }
}

export type NativeImage = NativeImageShim

export const nativeImage = {
  createFromPath: (_path: string): NativeImageShim => new NativeImageShim(),
  createFromBuffer: (_buffer: Buffer, _options?: unknown): NativeImageShim => new NativeImageShim(),
  createEmpty: (): NativeImageShim => new NativeImageShim(),
}

export type Rectangle = { x: number; y: number; width: number; height: number }

// ---------------------------------------------------------------------------
// safeStorage
//
// Storage is intentionally unencrypted so the desktop app and the web server
// share the same portable data.json.
// ---------------------------------------------------------------------------

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return false
  },
  encryptString(plainText: string): string {
    return plainText
  },
  decryptString(encrypted: Buffer | string): string {
    return Buffer.isBuffer(encrypted) ? encrypted.toString('utf-8') : encrypted
  },
}

// ---------------------------------------------------------------------------
// net (used by the Perplexity adapter)
// ---------------------------------------------------------------------------

interface NetRequestOptions {
  method?: string
  url: string
  headers?: Record<string, string>
}

function request(options: NetRequestOptions): EventEmitter {
  const emitter = new EventEmitter() as EventEmitter & {
    setHeader: (key: string, value: string) => void
    write: (chunk: string | Buffer) => void
    end: () => void
  }
  const headers: Record<string, string> = {}
  let body: Buffer | null = null

  emitter.setHeader = (key, value) => {
    headers[key] = value
  }
  emitter.write = (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    body = body ? Buffer.concat([body, buffer]) : buffer
  }
  emitter.end = () => {
    let parsed: URL
    try {
      parsed = new URL(options.url)
    } catch (error) {
      emitter.emit('error', error)
      return
    }

    const isHttps = parsed.protocol === 'https:'
    const lib = isHttps ? https : http
    const requestHeaders = { ...headers, 'accept-encoding': 'identity' }

    const req = lib.request(
      {
        method: options.method || 'GET',
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers: requestHeaders,
      },
      (res) => {
        const encoding = String(res.headers['content-encoding'] || '').toLowerCase()
        let stream: NodeJS.ReadableStream = res
        try {
          if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip())
          else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate())
          else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress())
        } catch {
          stream = res
        }
        const response = Object.assign(stream as any, {
          statusCode: res.statusCode,
          headers: res.headers,
        })
        emitter.emit('response', response)
      },
    )

    req.on('error', (error) => emitter.emit('error', error))
    if (body) req.write(body)
    req.end()
  }

  return emitter
}

export const net = { request }

export default {
  app,
  ipcMain,
  BrowserWindow,
  shell,
  session,
  screen,
  Tray,
  Menu,
  MenuItem,
  nativeImage,
  safeStorage,
  net,
}
