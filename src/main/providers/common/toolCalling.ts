/**
 * Provider-facing tool-calling facade.
 *
 * Providers import tool-calling helpers through this single stable module. The
 * underlying engine stays in `proxy/` (stable infrastructure); this facade is
 * the seam that lets provider modules avoid deep/private paths and lets the
 * engine relocate internally without touching every provider.
 */

// Prompt injection + legacy text parsing helpers
export {
  toolsToSystemPrompt,
  TOOL_WRAP_HINT,
  hasToolPromptInjected,
  shouldInjectToolPrompt,
} from '../../proxy/utils/tools.ts'
export { parseToolCallsFromText } from '../../proxy/utils/toolParser.ts'
export {
  createToolCallState,
  processStreamContent,
  flushToolCallBuffer,
  createBaseChunk,
} from '../../proxy/utils/streamToolHandler.ts'
export type { ToolCallState } from '../../proxy/utils/streamToolHandler.ts'
export { hasToolUse, parseToolUse } from '../../proxy/promptToolUse.ts'
export type { ToolCall } from '../../proxy/promptToolUse.ts'

// Provider tool profiles
export { getProviderToolProfile } from '../../proxy/toolCalling/providerProfiles.ts'
export type { ProviderToolProfile } from '../../proxy/toolCalling/providerProfiles.ts'

// Managed tool-calling engine surface
export { ToolStreamParser } from '../../proxy/toolCalling/ToolStreamParser.ts'
export { getToolProtocol } from '../../proxy/toolCalling/protocols/index.ts'
export { ToolCallingResponseError } from '../../proxy/toolCalling/ToolCallingEngine.ts'
export type {
  ToolCallingPlan,
  ToolCallingTransformResult,
  ToolProtocolId,
} from '../../proxy/toolCalling/types.ts'
