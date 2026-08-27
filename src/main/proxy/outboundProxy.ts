/**
 * Outbound Proxy Manager
 *
 * Provides an "on-demand proxy" fallback: upstream requests normally go direct.
 * When a provider rate-limits / blocks the direct connection (or the network
 * layer fails), the forwarder calls enterProxyMode(). In proxy mode, global
 * axios defaults route ALL upstream requests through a discovered HTTP proxy
 * (Clash/mixed port) and the Clash controller is switched to global mode so
 * domestic AI domains bypass DIRECT rules. Proxy mode persists: when the proxy
 * node itself gets rate-limited, the forwarder calls rotateProxy(), which
 * switches the Clash GLOBAL node to the next usable server.
 */

import axios from 'axios'
import net from 'net'

export interface OutboundProxyConfig {
  /** Connection timeout used when probing local proxy candidates */
  probeTimeoutMs: number
}

export const OUTBOUND_PROXY_CONFIG: OutboundProxyConfig = {
  probeTimeoutMs: 1200,
}

interface ProxyCandidate {
  protocol: 'http'
  host: string
  port: number
  source: string
}

export type ClashMode = 'rule' | 'global' | 'direct'

export class OutboundProxyManager {
  private config: OutboundProxyConfig = { ...OUTBOUND_PROXY_CONFIG }

  /** Discovered proxy candidates (deduped) */
  private candidates: ProxyCandidate[] = []

  /** Proxies that passed a real forwarding probe */
  private verified: ProxyCandidate[] = []

  /** Currently selected proxy candidate */
  private activeIndex = 0

  /** Whether outbound traffic is currently routed through the proxy */
  private proxyMode = false

  /** Clash external controller URL (e.g. http://127.0.0.1:9097) when present */
  private controllerUrl: string | null = null

  /** Clash "mode" observed before we switched it to global for proxy routing */
  private modeBeforeProxy: ClashMode | null = null

  /** Clash node name selected in GLOBAL before we started rotating */
  private nodeBeforeProxy: string | null = null

  /** Cached GLOBAL member list (proxy nodes only) used for rotation */
  private clashNodes: string[] = []

  /** Index into clashNodes for the next rotation attempt */
  private clashNodeIndex = 0

  private probing = false
  private bootstrapPromise: Promise<boolean> | null = null

  /** Prevent recursive logging */
  private logSuppressed = false

  isProxyMode(): boolean {
    return this.proxyMode
  }

  getActiveProxy(): ProxyCandidate | null {
    return this.verified[this.activeIndex] ?? null
  }

  getProxyUrl(): string {
    const proxy = this.getActiveProxy()
    return proxy ? `http://${proxy.host}:${proxy.port}` : ''
  }

  getControllerUrl(): string | null {
    return this.controllerUrl
  }

  /**
   * Detect whether an outbound proxy (Clash mixed port + controller) is
   * currently usable. Probes the local Clash ports and controller; returns the
   * discovered controller URL and proxy ports when they work.
   */
  async checkAvailability(): Promise<{
    available: boolean
    controllerUrl: string | null
    proxyPorts: number[]
    error?: string
  }> {
    const candidates = await this.discover()
    const proxyPorts = candidates
      .filter((c) => c.host === '127.0.0.1')
      .map((c) => c.port)
      .sort((a, b) => a - b)

    if (proxyPorts.length === 0) {
      return {
        available: false,
        controllerUrl: null,
        proxyPorts: [],
        error: 'No local proxy (Clash) port detected. Start Clash and try again.',
      }
    }
    if (!this.controllerUrl) {
      return {
        available: false,
        controllerUrl: null,
        proxyPorts,
        error: 'Clash controller not detected. Enable the external controller (e.g. 127.0.0.1:9097).',
      }
    }
    return { available: true, controllerUrl: this.controllerUrl, proxyPorts }
  }

  /** List real Clash proxy nodes available for selection. */
  async getNodes(): Promise<string[]> {
    const nodes = await this.loadClashNodes()
    if (nodes.length === 0 && this.clashNodes.length === 0) {
      // Ensure discovery happened even if loadClashNodes found nothing.
      await this.discoverController()
      return this.loadClashNodes()
    }
    return nodes.length > 0 ? nodes : this.clashNodes
  }

  /** Select a specific Clash node as the active exit. */
  async selectNode(name: string): Promise<boolean> {
    if (!this.controllerUrl) {
      await this.discoverController()
    }
    if (!this.controllerUrl) return false

    const ok = await this.changeClashNode(name)
    if (ok) {
      this.nodeBeforeProxy = name
      this.log(`Selected outbound proxy node: ${name}`)
    }
    return ok
  }

  /**
   * Turn the outbound proxy ON. Verifies availability first; refuses to enable
   * when no usable Clash proxy is detected.
   */
  async enable(): Promise<{ success: boolean; error?: string; node?: string | null }> {
    const availability = await this.checkAvailability()
    if (!availability.available) {
      return { success: false, error: availability.error }
    }

    const entered = await this.enterProxyMode()
    if (!entered) {
      return { success: false, error: 'Failed to activate outbound proxy.' }
    }
    const node = await this.getClashNode()
    return { success: true, node }
  }

  /** Turn the outbound proxy OFF and restore direct connections. */
  async disable(): Promise<{ success: boolean }> {
    this.resetToDirect()
    return { success: true }
  }

  /**
   * Discover available local HTTP proxies. Prefers the environment proxy when
   * set; otherwise probes well-known local Clash/mixed-protocol ports.
   */
  async discover(): Promise<ProxyCandidate[]> {
    const fromEnv = this.discoverFromEnv()
    const fromLocal = await this.discoverLocalClash()

    const merged = [...fromEnv, ...fromLocal].filter(
      (candidate, index, values) =>
        values.findIndex((other) =>
          other.host === candidate.host && other.port === candidate.port
        ) === index
    )

    this.candidates = merged
    return merged
  }

  private discoverFromEnv(): ProxyCandidate[] {
    const results: ProxyCandidate[] = []
    const names = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']
    const seen = new Set<string>()

    for (const name of names) {
      const value = process.env[name]
      if (!value) continue
      const parsed = this.parseProxyUrl(value)
      if (!parsed) continue
      const key = `${parsed.host}:${parsed.port}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push({ ...parsed, source: `env:${name}` })
    }
    return results
  }

  private async discoverLocalClash(): Promise<ProxyCandidate[]> {
    const known = [7890, 7897, 7898, 7892, 9249, 1080]
    const results: ProxyCandidate[] = []

    for (const port of known) {
      if (await this.canTcpConnect('127.0.0.1', port)) {
        results.push({ protocol: 'http', host: '127.0.0.1', port, source: 'local-probe' })
      }
    }

    // Detect the Clash external controller so we can steer traffic away from
    // DIRECT rules (often the cause of "proxy still rate-limited").
    await this.discoverController()
    return results
  }

  private async discoverController(): Promise<string | null> {
    const controllerPorts = [9097, 9090, 9091, 9098, 6170, 6171]
    for (const port of controllerPorts) {
      const url = `http://127.0.0.1:${port}`
      try {
        const response = await axios.get(`${url}/version`, {
          timeout: this.config.probeTimeoutMs,
          proxy: false,
          validateStatus: () => true,
        })
        if (response.status === 200 && /"meta"|"version"|"Path"/.test(JSON.stringify(response.data))) {
          this.controllerUrl = url
          return url
        }
      } catch {
        // not a controller on this port
      }
    }
    return null
  }

  private async getClashMode(): Promise<ClashMode | null> {
    if (!this.controllerUrl) return null
    try {
      const response = await axios.get(`${this.controllerUrl}/configs`, {
        timeout: this.config.probeTimeoutMs * 2,
        proxy: false,
        validateStatus: () => true,
      })
      const mode = response.data?.mode
      return mode === 'rule' || mode === 'global' || mode === 'direct' ? mode : null
    } catch {
      return null
    }
  }

  private async setClashMode(mode: ClashMode): Promise<boolean> {
    if (!this.controllerUrl) return false
    try {
      const response = await axios.patch(
        `${this.controllerUrl}/configs`,
        { mode },
        {
          timeout: this.config.probeTimeoutMs * 2,
          proxy: false,
          validateStatus: () => true,
        },
      )
      return response.status >= 200 && response.status < 300
    } catch {
      return false
    }
  }

  /**
   * Read the current real proxy nodes from the Clash instance. Called fresh on
   * every rotation so nodes that recovered are picked up again and ones that
   * just died are pushed to the back.
   */
  private async loadClashNodes(): Promise<string[]> {
    if (!this.controllerUrl) return []
    try {
      const response = await axios.get(`${this.controllerUrl}/proxies`, {
        timeout: this.config.probeTimeoutMs * 2,
        proxy: false,
        validateStatus: () => true,
      })
      const allProxies: Record<string, ClashProxyEntry> = response.data?.proxies ?? {}
      this.clashNodes = filterRealClashNodes(allProxies)
      return this.clashNodes
    } catch {
      return []
    }
  }

  private async changeClashNode(name: string): Promise<boolean> {
    if (!this.controllerUrl) return false
    try {
      const response = await axios.put(
        `${this.controllerUrl}/proxies/GLOBAL`,
        { name },
        {
          timeout: this.config.probeTimeoutMs * 2,
          proxy: false,
          validateStatus: () => true,
        },
      )
      return response.status >= 200 && response.status < 300
    } catch {
      return false
    }
  }

  /**
   * Verify that the currently selected Clash node can actually reach the AI
   * providers by issuing a small HTTPS request through the local mixed port.
   * Returns true when the node is usable end-to-end.
   */
  private async verifyClashNodeExit(): Promise<boolean> {
    const proxy = this.getActiveProxy()
    if (!proxy) return false
    try {
      const response = await axios.get('https://chatglm.cn/', {
        proxy: { protocol: 'http', host: proxy.host, port: proxy.port },
        timeout: this.config.probeTimeoutMs * 8,
        validateStatus: () => true,
        maxRedirects: 0,
      })
      // 4xx/5xx from chatglm still means "we reached it"; a proxy-level failure
      // surfaces as an exception instead.
      return response.status >= 200 && response.status < 600
    } catch {
      return false
    }
  }

  /**
   * Rotate to the next usable Clash node. Re-reads the node list on every call
   * (so recovered nodes are eligible again), then walks candidates starting
   * after the last selection, verifying each one end-to-end. Dead or broken
   * nodes are skipped; the first node that actually reaches the provider wins.
   * Returns the verified node name or null when nothing usable is found.
   */
  async rotateToNextNode(): Promise<string | null> {
    // Fresh list each rotation — dead nodes may have recovered, and alive
    // nodes are ordered first by mihomo health + latency.
    await this.loadClashNodes()
    if (this.clashNodes.length === 0 || !this.controllerUrl) return null

    const startIndex = this.clashNodeIndex
    const total = this.clashNodes.length

    for (let i = 1; i <= total; i++) {
      this.clashNodeIndex = (startIndex + i) % total
      const node = this.clashNodes[this.clashNodeIndex]
      if (!node) continue

      const ok = await this.changeClashNode(node)
      if (!ok) continue

      if (await this.verifyClashNodeExit()) {
        this.log(`Rotated outbound proxy node to: ${node} (verified)`)
        return node
      }
      this.log(`Proxy node unusable, skipping: ${node}`)
    }

    this.log('All proxy nodes failed verification; keeping last selection')
    return null
  }

  /** Current Clash GLOBAL node name (for diagnostics). */
  async getClashNode(): Promise<string | null> {
    if (!this.controllerUrl) return null
    try {
      const response = await axios.get(`${this.controllerUrl}/proxies/GLOBAL`, {
        timeout: this.config.probeTimeoutMs * 2,
        proxy: false,
        validateStatus: () => true,
      })
      return response.data?.now ?? null
    } catch {
      return null
    }
  }

  /**
   * Verify each candidate can actually tunnel HTTPS. Keeps only the working
   * ones, ordered by latency.
   */
  async verify(): Promise<ProxyCandidate[]> {
    this.probing = true
    try {
      const results: Array<{ candidate: ProxyCandidate; latency: number }> = []
      for (const candidate of this.candidates) {
        const start = Date.now()
        const ok = await this.tryHttpsViaProxy(candidate)
        if (ok) {
          results.push({ candidate, latency: Date.now() - start })
        }
      }
      results.sort((a, b) => a.latency - b.latency)
      this.verified = results.map((r) => r.candidate)
      return this.verified
    } finally {
      this.probing = false
    }
  }

  /**
   * Called by the forwarder when a rate limit / block / network failure is
   * detected. Switches to proxy mode (if a proxy is available) and applies the
   * global axios proxy. Once enabled, proxy mode persists — subsequent rate
   * limits rotate the Clash node instead of falling back to direct.
   */
  async enterProxyMode(): Promise<boolean> {
    const ready = await this.bootstrapProxies()

    if (ready && this.verified.length > 0) {
      // Steer traffic away from DIRECT rules. When a Clash controller is
      // present, switch to global mode so even domestic AI domains route
      // through the selected proxy node. Remember the original mode & node so
      // a later resetToDirect() can restore them.
      if (this.controllerUrl) {
        if (this.modeBeforeProxy === null) {
          this.modeBeforeProxy = await this.getClashMode()
          this.nodeBeforeProxy = await this.getClashNode()
          const nodes = await this.loadClashNodes()
          if (nodes.length > 0) {
            const currentResult = this.nodeBeforeProxy
            const index = nodes.indexOf(currentResult ?? '')
            this.clashNodeIndex = index >= 0 ? index : 0
          }
        }
        await this.setClashMode('global')
      }

      this.proxyMode = true
      this.applyAxiosDefaults()
      this.log(`Switching outbound traffic to proxy: ${this.getProxyUrl()}`)
      return true
    }

    this.log('No usable outbound proxy discovered; keeping direct connection')
    return false
  }

  /**
   * Rotate the outbound exit to the next Clash node. Called when the current
   * proxy node is itself rate-limited. Returns the new node name or null.
   */
  async rotateProxy(): Promise<string | null> {
    return this.rotateToNextNode()
  }

  /** Immediately return to direct connections and restore Clash mode/node. */
  resetToDirect(): void {
    this.proxyMode = false
    // Restore the Clash routing mode & node observed before switching.
    if (this.modeBeforeProxy !== null) {
      void this.setClashMode(this.modeBeforeProxy)
      this.modeBeforeProxy = null
    }
    if (this.controllerUrl && this.nodeBeforeProxy !== null && this.clashNodes.length > 0) {
      void this.changeClashNode(this.nodeBeforeProxy)
      this.nodeBeforeProxy = null
      this.clashNodes = []
    }
    // Undo the global proxy override so axios falls back to its default
    // behaviour (honouring HTTP_PROXY/HTTPS_PROXY if the user sets them).
    axios.defaults.proxy = undefined
    this.log('Outbound traffic restored to direct connection')
  }

  private applyAxiosDefaults(): void {
    const proxy = this.getActiveProxy()
    axios.defaults.proxy = proxy
      ? { protocol: 'http', host: proxy.host, port: proxy.port }
      : undefined
  }

  /**
   * Ensure the proxy pool is bootstrapped and enter proxy mode. Awaits the
   * in-flight bootstrap (bounded by `timeoutMs`) so the caller can re-send the
   * current request through the proxy.
   */
  async ensureProxyForRequest(timeoutMs = 5000): Promise<boolean> {
    if (this.proxyMode && this.verified.length > 0) {
      return true
    }

    const startedAt = Date.now()
    const result = await this.enterProxyMode()
    if (result) return true

    // enterProxyMode already bootstrapped; wait for completion if still probing.
    while (this.bootstrapPromise && Date.now() - startedAt < timeoutMs) {
      await this.delay(100)
    }
    if (this.verified.length > 0) {
      this.proxyMode = true
      this.applyAxiosDefaults()
      return true
    }
    return false
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async bootstrapProxies(): Promise<boolean> {
    if (this.bootstrapPromise) return this.bootstrapPromise
    if (this.candidates.length > 0 && this.verified.length > 0) return true

    this.bootstrapPromise = (async () => {
      const candidates = await this.discover()
      if (candidates.length === 0) return false
      await this.verify()
      if (this.verified.length === 0) return false
      this.activeIndex = 0
      return true
    })().finally(() => {
      this.bootstrapPromise = null
    })

    return this.bootstrapPromise
  }

  private parseProxyUrl(value: string): ProxyCandidate | null {
    if (!value) return null
    let url: URL
    try {
      url = value.startsWith('http://') || value.startsWith('https://')
        ? new URL(value)
        : new URL(`http://${value}`)
    } catch {
      return null
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const port = url.port ? Number(url.port) : 80
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    return { protocol: 'http', host: url.hostname, port, source: 'env' }
  }

  private canTcpConnect(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect(port, host)
      const finish = (ok: boolean): void => {
        socket.destroy()
        resolve(ok)
      }
      socket.setTimeout(this.config.probeTimeoutMs)
      socket.on('connect', () => finish(true))
      socket.on('error', () => finish(false))
      socket.on('timeout', () => finish(false))
    })
  }

  private tryHttpsViaProxy(candidate: ProxyCandidate): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect(candidate.port, candidate.host)
      const done = (ok: boolean): void => {
        clearTimeout(timer)
        socket.destroy()
        resolve(ok)
      }
      const timer = setTimeout(() => done(false), this.config.probeTimeoutMs * 3)
      socket.setTimeout(this.config.probeTimeoutMs * 3)
      socket.on('timeout', () => done(false))
      socket.on('error', () => done(false))
      socket.on('connect', () => {
        socket.write(
          `CONNECT www.gstatic.com:443 HTTP/1.1\r\nHost: www.gstatic.com:443\r\n\r\n`,
        )
      })
      socket.on('data', (chunk) => {
        const head = chunk.toString('utf8').slice(0, 24)
        if (/^HTTP\/\d(?:\.\d)?\s+200/.test(head)) {
          done(true)
        }
      })
      socket.on('close', () => { /* timeout or failure will resolve */ })
    })
  }

  private log(message: string): void {
    if (this.logSuppressed) return
    console.log(`[OutboundProxy] ${message}`)
    // Record into app logs via storeManager; lazily imported to avoid cycles.
    import('../store/store').then(({ storeManager }) => {
      storeManager.addLog('info', `[OutboundProxy] ${message}`)
    }).catch(() => {})
  }
}

export interface ClashProxyEntry {
  type?: string
  alive?: boolean
  history?: Array<{ delay?: number }>
}

/**
 * Keep the real proxy nodes from a Clash /proxies payload, sorted so that
 * alive nodes (mihomo health-check OK) with the lowest latency come first.
 * Dead nodes are NOT dropped — they can come back up later, so they stay in
 * the pool ranked last. DIRECT/REJECT, traffic banners and policy groups are
 * always excluded.
 */
export function filterRealClashNodes(
  allProxies: Record<string, ClashProxyEntry | undefined>,
): string[] {
  const policyGroupTypes = new Set(['selector', 'urltest', 'fallback', 'loadbalance'])
  const nonNodeTypes = new Set([
    'compatible', 'pass', 'reject', 'rejectdrop', 'direct',
  ])
  const nodes: Array<{ name: string; alive: boolean; delay: number }> = []
  for (const [name, entry] of Object.entries(allProxies)) {
    if (!entry) continue
    const type = (entry.type ?? '').toLowerCase()
    if (type.length === 0) continue
    if (policyGroupTypes.has(type)) continue
    if (nonNodeTypes.has(type)) continue
    if (name === 'DIRECT' || name === 'REJECT' || name === 'PASS') continue
    if (/^(剩余流量|套餐到期|过滤掉\d+条线路)/.test(name)) continue
    const alive = entry.alive !== false
    const delay = entry.history && entry.history[0]?.delay
      ? entry.history[0].delay
      : Number.MAX_SAFE_INTEGER
    nodes.push({ name, alive, delay })
  }
  nodes.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1
    return a.delay - b.delay
  })
  return nodes.map((n) => n.name)
}

export const outboundProxyManager = new OutboundProxyManager()
export default outboundProxyManager