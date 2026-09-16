/**
 * Per-request proxy injection into axios.
 *
 * A single request interceptor is installed on the default axios instance (and
 * on any instance created through `createEgressAxios`) that reads the current
 * egress exit from the async-local context and applies it to that one request.
 * Global `axios.defaults.proxy` is never mutated.
 */

import axios, {
  type AxiosInstance,
  type AxiosProxyConfig,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { getCurrentEgress } from './context'
import type { EgressExit } from './types'

function encodeAuth(exit: EgressExit): string {
  if (!exit.username) return ''
  const user = encodeURIComponent(exit.username)
  const pass = encodeURIComponent(exit.password ?? '')
  return `${user}:${pass}@`
}

/**
 * Build the axios proxy/agent fragment for an exit. SOCKS exits are applied via
 * agents (axios does not natively support SOCKS through `proxy`).
 */
export function buildAxiosProxyConfig(exit: EgressExit): Partial<AxiosRequestConfig> {
  if (exit.protocol === 'socks5' || exit.protocol === 'socks5h') {
    const agent = new SocksProxyAgent(
      `${exit.protocol}://${encodeAuth(exit)}${exit.host}:${exit.port}`,
    )
    return { proxy: false, httpAgent: agent, httpsAgent: agent }
  }

  const proxy: AxiosProxyConfig = {
    host: exit.host,
    port: exit.port,
    protocol: exit.protocol === 'https' ? 'https' : 'http',
  }
  if (exit.username) {
    proxy.auth = { username: exit.username, password: exit.password ?? '' }
  }
  return { proxy }
}

/** Apply an exit to a config object unless the caller already set a proxy. */
export function applyExitToConfig(
  config: InternalAxiosRequestConfig | AxiosRequestConfig,
  exit: EgressExit,
): AxiosRequestConfig {
  if (config.proxy !== undefined) return config
  return { ...config, ...buildAxiosProxyConfig(exit) }
}

/** Install the per-request egress interceptor on an axios instance. */
export function installEgressInterceptor(instance: AxiosInstance): void {
  instance.interceptors.request.use((config) => {
    const exit = getCurrentEgress()
    if (!exit) return config
    return applyExitToConfig(config, exit) as InternalAxiosRequestConfig
  })
}

/** Create an axios instance that honours the request-scoped egress exit. */
export function createEgressAxios(config?: AxiosRequestConfig): AxiosInstance {
  const instance = axios.create(config)
  installEgressInterceptor(instance)
  return instance
}

/** Install the interceptor on the default axios export (idempotent). */
export function installDefaultEgressInterceptor(): void {
  installEgressInterceptor(axios)
}

/** Issue a request through an explicit exit, ignoring the async context. */
export async function requestViaExit<T = unknown>(
  exit: EgressExit,
  config: AxiosRequestConfig,
): Promise<T> {
  const response = await axios.request<T>({ ...config, ...buildAxiosProxyConfig(exit) })
  return response.data
}
