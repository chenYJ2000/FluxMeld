import type { ChatCompletionRequest } from './types'
import { resolveToolClientAdapterForRequest } from './toolCalling/clientAdapters'

const OPENCODE_TOOL_REQUEST_MIN_TIMEOUT_MS = 180_000

/**
 * OpenCode supplies a large tool schema and expects the model to inspect the
 * workspace before replying. A normal 60 second proxy deadline is frequently
 * shorter than the first tool-planning turn for hosted coding models. Keep a
 * user's longer timeout intact, while giving OpenCode tool requests a safe
 * minimum that is still below the application's configured maximum.
 */
export function getEffectiveRequestTimeout(
  request: ChatCompletionRequest,
  clientAdapterId: string | undefined,
  configuredTimeoutMs: number,
): number {
  const isOpenCodeToolRequest =
    resolveToolClientAdapterForRequest(clientAdapterId ?? 'standard-openai-tools', request).adapter
      .id === 'opencode' &&
    Array.isArray(request.tools) &&
    request.tools.length > 0

  return isOpenCodeToolRequest
    ? Math.max(configuredTimeoutMs, OPENCODE_TOOL_REQUEST_MIN_TIMEOUT_MS)
    : configuredTimeoutMs
}
