/**
 * Clash/mihomo egress source.
 *
 * Routes through the configured Clash proxy port and switches the controller's
 * GLOBAL node to select the exit. The pre-existing routing mode/node are saved
 * on first apply and restored on deactivate.
 */

import { ClashController, type ClashMode } from './controller.ts'
import { CLASH_META } from './config.ts'
import { canTcpConnect } from '../common/discovery.ts'
import { resolveSourceSettings } from '../common/fields.ts'
import type {
  EgressExit,
  EgressProbeResult,
  EgressServices,
  EgressSource,
  EgressSourceModuleMeta,
} from '../types.ts'

const PROBE_TIMEOUT_MS = 1200

interface ClashSettings {
  host: string
  controllerPort: number
  proxyPort: number
  secret: string
}

export class ClashSource implements EgressSource {
  readonly meta: EgressSourceModuleMeta = CLASH_META

  private controller: ClashController | null = null
  private controllerSignature: string | null = null
  private controllerVerified = false
  private modeBefore: ClashMode | null = null
  private nodeBefore: string | null = null

  constructor(private readonly services: EgressServices) {}

  private getSettings(): ClashSettings {
    // Defaults and port bounds live on CLASH_META.fields, applied by the resolver.
    const settings = resolveSourceSettings(CLASH_META, this.services.getSettings())
    return {
      host: String(settings.clashHost),
      controllerPort: Number(settings.controllerPort),
      proxyPort: Number(settings.proxyPort),
      secret: String(settings.secret),
    }
  }

  private getProxyAddress(): { host: string; port: number } {
    const { host, proxyPort } = this.getSettings()
    return { host, port: proxyPort }
  }

  private getController(): ClashController {
    const { host, controllerPort, secret } = this.getSettings()
    const baseUrl = `http://${host}:${controllerPort}`
    const signature = `${baseUrl}|${secret}`
    if (this.controller && this.controllerSignature === signature) return this.controller

    this.controller = new ClashController(baseUrl, secret, PROBE_TIMEOUT_MS)
    this.controllerSignature = signature
    this.controllerVerified = false
    return this.controller
  }

  private async discoverController(): Promise<ClashController | null> {
    const controller = this.getController()
    if (this.controllerVerified) return controller
    if (await controller.probe()) {
      this.controllerVerified = true
      return controller
    }
    return null
  }

  async probe(): Promise<EgressProbeResult> {
    const proxy = this.getProxyAddress()
    const controller = await this.discoverController()
    const proxyReachable = await canTcpConnect(proxy.host, proxy.port, PROBE_TIMEOUT_MS)

    if (!proxyReachable) {
      return {
        available: false,
        error: `Clash proxy port unreachable: ${proxy.host}:${proxy.port}`,
        details: { proxyHost: proxy.host, proxyPort: proxy.port },
      }
    }

    if (!controller) {
      const { host, controllerPort } = this.getSettings()
      return {
        available: false,
        error: `Clash controller unavailable: http://${host}:${controllerPort}`,
        details: { proxyHost: proxy.host, proxyPort: proxy.port },
      }
    }

    return {
      available: true,
      details: {
        controllerUrl: controller.baseUrl,
        proxyHost: proxy.host,
        proxyPort: proxy.port,
      },
    }
  }

  async listExits(): Promise<EgressExit[]> {
    const controller = await this.discoverController()
    if (!controller) return []

    const proxy = this.getProxyAddress()
    const entries = await controller.listNodes()
    return entries.map((entry) => ({
      id: entry.name,
      name: entry.name,
      protocol: 'http',
      host: proxy.host,
      port: proxy.port,
      selectable: entry.selectable,
      alive: entry.alive,
    }))
  }

  async apply(exit: EgressExit): Promise<boolean> {
    const controller = await this.discoverController()
    if (!controller) return false

    if (this.modeBefore === null) {
      this.modeBefore = await controller.getMode()
      this.nodeBefore = await controller.getCurrentNode()
    }
    await controller.setMode('global')
    return controller.changeNode(exit.id)
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
