/**
 * Clash/mihomo egress source.
 *
 * Routes through the local Clash mixed port and switches the controller's
 * GLOBAL node to select the exit. The pre-existing routing mode/node are saved
 * on first apply and restored on deactivate.
 */

import { ClashController, type ClashMode } from './controller.ts'
import { CLASH_META } from './config.ts'
import { canTcpConnect, discoverEnvProxies } from '../common/discovery.ts'
import type {
  EgressExit,
  EgressProbeResult,
  EgressServices,
  EgressSource,
  EgressSourceModuleMeta,
} from '../types.ts'

const KNOWN_PROXY_PORTS = [7890, 7897, 7898, 7892, 9249, 1080]
const KNOWN_CONTROLLER_PORTS = [9097, 9090, 9091, 9098, 6170, 6171]
const PROBE_TIMEOUT_MS = 1200
const LOCAL_HOST = '127.0.0.1'

export class ClashSource implements EgressSource {
  readonly meta: EgressSourceModuleMeta = CLASH_META

  private controller: ClashController | null = null
  private proxyHost: string | null = null
  private proxyPort: number | null = null
  private modeBefore: ClashMode | null = null
  private nodeBefore: string | null = null

  constructor(private readonly services: EgressServices) {}

  private getSettings(): { controllerUrl: string; secret: string } {
    const settings = this.services.getSettings()
    return {
      controllerUrl: String(settings.controllerUrl ?? '').trim(),
      secret: String(settings.secret ?? '').trim(),
    }
  }

  private normalizeControllerUrl(value: string): string | null {
    const trimmed = value.trim()
    if (!trimmed) return null
    try {
      const url =
        trimmed.startsWith('http://') || trimmed.startsWith('https://')
          ? new URL(trimmed)
          : new URL(`http://${trimmed}`)
      return `${url.protocol}//${url.host}`
    } catch {
      return null
    }
  }

  private async discoverController(): Promise<ClashController | null> {
    if (this.controller && (await this.controller.probe())) return this.controller

    const { controllerUrl, secret } = this.getSettings()

    if (controllerUrl) {
      const url = this.normalizeControllerUrl(controllerUrl)
      if (url) {
        const candidate = new ClashController(url, secret, PROBE_TIMEOUT_MS)
        if (await candidate.probe()) {
          this.controller = candidate
          return candidate
        }
      }
    }

    for (const port of KNOWN_CONTROLLER_PORTS) {
      const candidate = new ClashController(`http://127.0.0.1:${port}`, secret, PROBE_TIMEOUT_MS)
      if (await candidate.probe()) {
        this.controller = candidate
        return candidate
      }
    }

    return null
  }

  private async discoverProxy(): Promise<{ host: string; port: number } | null> {
    for (const port of KNOWN_PROXY_PORTS) {
      if (await canTcpConnect(LOCAL_HOST, port, PROBE_TIMEOUT_MS)) {
        return { host: LOCAL_HOST, port }
      }
    }
    const env = discoverEnvProxies()
    if (env.length > 0) {
      return { host: env[0].host, port: env[0].port }
    }
    return null
  }

  private async ensureDiscovered(): Promise<void> {
    if (this.proxyPort === null) {
      const proxy = await this.discoverProxy()
      if (proxy) {
        this.proxyHost = proxy.host
        this.proxyPort = proxy.port
      }
    }
    if (!this.controller) {
      await this.discoverController()
    }
  }

  async probe(): Promise<EgressProbeResult> {
    await this.ensureDiscovered()

    if (this.proxyPort === null) {
      return {
        available: false,
        error: 'No local proxy (Clash) port detected. Start Clash and try again.',
      }
    }
    if (!this.controller) {
      return {
        available: false,
        error:
          'Clash controller not detected. Enable the external controller and set its address/secret in the egress source settings.',
        details: { proxyPort: this.proxyPort },
      }
    }
    return {
      available: true,
      details: {
        controllerUrl: this.controller.baseUrl,
        proxyHost: this.proxyHost,
        proxyPort: this.proxyPort,
      },
    }
  }

  async listExits(): Promise<EgressExit[]> {
    await this.ensureDiscovered()
    if (!this.controller || this.proxyPort === null || this.proxyHost === null) return []

    const nodes = await this.controller.listNodes()
    return nodes.map((name) => ({
      id: name,
      name,
      protocol: 'http',
      host: this.proxyHost as string,
      port: this.proxyPort as number,
    }))
  }

  async apply(exit: EgressExit): Promise<boolean> {
    await this.ensureDiscovered()
    if (!this.controller) return false

    if (this.modeBefore === null) {
      this.modeBefore = await this.controller.getMode()
      this.nodeBefore = await this.controller.getCurrentNode()
    }
    await this.controller.setMode('global')
    return this.controller.changeNode(exit.id)
  }

  async deactivate(): Promise<void> {
    if (!this.controller) return
    if (this.modeBefore !== null) {
      await this.controller.setMode(this.modeBefore)
      this.modeBefore = null
    }
    if (this.nodeBefore !== null) {
      await this.controller.changeNode(this.nodeBefore)
      this.nodeBefore = null
    }
  }
}
