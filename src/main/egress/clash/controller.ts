/**
 * Clash/mihomo external controller client.
 *
 * Thin wrapper around the external controller REST API used to switch routing
 * mode and select the active proxy node.
 */

import axios, { type AxiosResponse } from 'axios'
import { filterRealClashNodes, type ClashProxyEntry } from './nodes.ts'

export type ClashMode = 'rule' | 'global' | 'direct'

export class ClashController {
  constructor(
    readonly baseUrl: string,
    private readonly secret: string,
    private readonly timeoutMs: number,
  ) {}

  private headers(): Record<string, string> {
    return this.secret ? { Authorization: `Bearer ${this.secret}` } : {}
  }

  private async request(
    method: 'get' | 'patch' | 'put',
    path: string,
    data?: unknown,
    timeoutMs: number = this.timeoutMs,
  ): Promise<AxiosResponse | null> {
    try {
      return await axios.request({
        method,
        url: `${this.baseUrl}${path}`,
        data,
        headers: { ...this.headers() },
        timeout: timeoutMs,
        proxy: false,
        validateStatus: () => true,
      })
    } catch {
      return null
    }
  }

  async probe(): Promise<boolean> {
    const response = await this.request('get', '/version')
    return (
      !!response &&
      response.status === 200 &&
      /"meta"|"version"|"Path"/.test(JSON.stringify(response.data))
    )
  }

  async getMode(): Promise<ClashMode | null> {
    const response = await this.request('get', '/configs', undefined, this.timeoutMs * 2)
    const mode = response?.data?.mode
    return mode === 'rule' || mode === 'global' || mode === 'direct' ? mode : null
  }

  async setMode(mode: ClashMode): Promise<boolean> {
    const response = await this.request('patch', '/configs', { mode }, this.timeoutMs * 2)
    return !!response && response.status >= 200 && response.status < 300
  }

  async listNodes(): Promise<string[]> {
    const response = await this.request('get', '/proxies', undefined, this.timeoutMs * 2)
    if (!response) return []
    const allProxies: Record<string, ClashProxyEntry> = response.data?.proxies ?? {}
    return filterRealClashNodes(allProxies)
  }

  async getCurrentNode(): Promise<string | null> {
    const response = await this.request('get', '/proxies/GLOBAL', undefined, this.timeoutMs * 2)
    return response?.data?.now ?? null
  }

  async changeNode(name: string): Promise<boolean> {
    const response = await this.request('put', '/proxies/GLOBAL', { name }, this.timeoutMs * 2)
    return !!response && response.status >= 200 && response.status < 300
  }
}
