import type { ChatMessage, ChatCompletionTool, ToolCall } from '../types.ts'

export type ToolCallingMode = 'managed' | 'disabled'
export type ToolProtocolId =
  'openai_chat' | 'managed_bracket' | 'managed_xml' | 'anthropic_tool_use' | 'codex_responses'

export type ToolSource = 'openai' | 'mcp'

export type JsonRuntimeType =
  'missing' | 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'unknown'

/**
 * Structural validation context safe for diagnostics. Values are deliberately
 * excluded so trading arguments and other tool payload data are not logged.
 */
export interface ToolArgumentValidationIssue {
  jsonPointer: string
  keyword: string
  message: string
  expected: string
  actualType: JsonRuntimeType
}

export interface NormalizedToolDefinition {
  name: string
  description?: string
  parameters: Record<string, unknown>
  source: ToolSource
}

export interface NormalizedToolCall {
  id: string
  index: number
  name: string
  arguments: string
  protocol: ToolProtocolId
  rawText?: string
}

export interface NormalizedToolResult {
  toolCallId: string
  name?: string
  content: string
}

export interface ToolCallDiagnostics {
  requestId?: string
  clientAdapterId: string
  configuredClientAdapterId?: string
  clientAdapterResolution?: 'configuration' | 'request_identity'
  detectedClientType?: string
  providerId: string
  model?: string
  actualModel?: string
  toolSource: 'openai' | 'mcp' | 'none'
  mode: ToolCallingMode
  protocol: ToolProtocolId
  toolCount: number
  injected: boolean
  reason: string
  parserFormat?: ToolProtocolId | 'unknown'
  detectedProtocols?: ToolProtocolId[]
  parsedToolCallCount?: number
  malformedReason?: string
  invalidToolNames?: string[]
  malformedToolNames?: string[]
  fencedBlockDetected?: boolean
  toolRefusalDetected?: boolean
  refusedToolName?: string
  rawContentPreview?: string
  rawMatchPreviews?: string[]
  parsedArgumentsPreview?: Array<{ name: string; arguments: string }>
  schemaValidationErrors?: string[]
  schemaValidationIssues?: ToolArgumentValidationIssue[]
  wrapperLeakDetected?: boolean
  upstreamEventSummary?: {
    eventCount: number
    responseCreatedCount: number
    responseCreatedChoiceOffsets: number[]
    choiceEventCount: number
    maxChoicesPerEvent: number
    choiceIndices: Array<string | number>
    candidateCount: number
    candidateSequence: string[]
    identityFields: string[]
    phaseStatusPairs: string[]
    deltaKeySets: string[]
    contentChunkCount: number
    contentChars: number
  }
  candidateContentCount?: number
  selectedCandidateIndex?: number
  candidateAttempts?: Array<{
    index: number
    chars: number
    parserFormat?: ToolProtocolId | 'unknown'
    detectedProtocols?: ToolProtocolId[]
    malformedReason?: string
    rawContentPreview?: string
  }>
  toolChoiceMode?: 'auto' | 'none' | 'required' | 'forced'
  forcedToolName?: string
  allowedToolNames?: string[]
}

export interface ToolCallingPlan {
  mode: ToolCallingMode
  protocol: ToolProtocolId
  clientAdapterId: string
  providerId: string
  tools: NormalizedToolDefinition[]
  shouldInjectPrompt: boolean
  shouldParseResponse: boolean
  toolChoiceMode: 'auto' | 'none' | 'required' | 'forced'
  allowedToolNames: Set<string>
  forcedToolName?: string
  diagnostics: ToolCallDiagnostics
}

export interface ToolCallingTransformResult {
  messages: ChatMessage[]
  tools?: ChatCompletionTool[]
  plan: ToolCallingPlan
}

export interface ToolParseContext {
  tools: NormalizedToolDefinition[]
  protocol: ToolProtocolId
}

export interface ToolParseResult {
  content: string
  toolCalls: ToolCall[]
  protocol: ToolProtocolId | 'unknown'
  rawMatches: string[]
  malformedReason?: string
  invalidToolNames: string[]
  malformedToolNames?: string[]
  detectedProtocols?: ToolProtocolId[]
}
