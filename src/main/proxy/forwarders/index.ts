/**
 * Provider forwarder registry.
 *
 * Each provider is registered here exactly once. `RequestForwarder` consumes
 * this list and dispatches on `matches(provider)`; adding a provider therefore
 * only requires a new entry (and its forwarder module), not edits to the
 * orchestration logic.
 */

import { createDeepSeekForwarder } from './deepseek'
import { createGLMForwarder } from './glm'
import { createKimiForwarder } from './kimi'
import { createQwenForwarder } from './qwen'
import { createQwenAiForwarder } from './qwen-ai'
import { createZaiForwarder } from './zai'
import { createMiniMaxForwarder } from './minimax'
import { createMimoForwarder } from './mimo'
import { createPerplexityForwarder } from './perplexity'
import type { ForwarderServices, ProviderForwarder } from './types'

export type { ForwarderServices, ProviderForwarder } from './types'
export { createForwardFailure, getForwardErrorStatus } from './errors'

export function createProviderForwarders(services: ForwarderServices): ProviderForwarder[] {
  return [
    createDeepSeekForwarder(services),
    createGLMForwarder(services),
    createKimiForwarder(services),
    createQwenForwarder(services),
    createQwenAiForwarder(services),
    createZaiForwarder(services),
    createMiniMaxForwarder(services),
    createMimoForwarder(services),
    createPerplexityForwarder(services),
  ]
}
