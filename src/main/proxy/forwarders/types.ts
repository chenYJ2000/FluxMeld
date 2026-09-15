/**
 * Provider forwarder extension contracts.
 *
 * A `ProviderForwarder` is the open/closed seam of the proxy: adding a provider
 * means registering a new forwarder (see `./index.ts`) without touching the
 * generic orchestration in `../forwarder.ts`.
 */

import type { PassThrough } from 'stream'
import type { Account, Provider } from '../../store/types'
import type { ChatCompletionRequest, ForwardResult, ProxyContext } from '../types'
import type { ToolCallingTransformResult } from '../toolCalling/types'

/**
 * Host capabilities injected into every provider forwarder. Implemented by
 * `RequestForwarder`; provider forwarders must not depend on the concrete
 * orchestration class.
 */
export interface ForwarderServices {
  transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider,
  ): ToolCallingTransformResult
  applyToolCallsToResponse(result: any, transformed: ToolCallingTransformResult): void
  createBufferedResponseStream(result: any, model: string): PassThrough
  extractHeaders(headers: any): Record<string, string>
  shouldDeleteSession(): boolean
}

export interface ProviderForwarder {
  name: string
  matches(provider: Provider): boolean
  forward(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    context: ProxyContext,
  ): Promise<ForwardResult>
}
