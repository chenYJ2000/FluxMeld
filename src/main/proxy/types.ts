/**
 * Proxy Service Module - Type Definitions
 * Defines core data structures for proxy service
 */

/**
 * OpenAI Message Format
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ChatMessageContent[] | null
  name?: string
  tool_call_id?: string
  tool_calls?: ChatCompletionMessageToolCall[]
}

/**
 * Tool Call in Message
 */
export interface ChatCompletionMessageToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Tool Definition for Function Calling (OpenAI compatible)
 */
export interface ChatCompletionTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, any>
  }
}

/**
 * Tool Choice Strategy
 */
export type ChatCompletionToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | {
      type: 'function'
      function: { name: string }
    }

/**
 * Message Content (supports multimodal)
 */
export interface ChatMessageContent {
  type: 'text' | 'image_url'
  text?: string
  image_url?: {
    url: string
    detail?: 'auto' | 'low' | 'high'
  }
}

/**
 * Chat Completions Request
 */
export interface ChatCompletionRequest {
  model: string
  /** Original model name before mapping (used for feature detection like web search, thinking mode) */
  originalModel?: string
  messages: ChatMessage[]
  /**
   * FluxMeld stateful-session extension. When present, the proxy restores the
   * locally persisted conversation before forwarding this turn.
   */
  session_id?: string
  /** Camel-case alias for SDKs that normalize custom request fields. */
  sessionId?: string
  temperature?: number
  top_p?: number
  n?: number
  stream?: boolean
  stop?: string | string[]
  max_tokens?: number
  /** Maximum total generated tokens (reasoning + answer) */
  max_completion_tokens?: number
  presence_penalty?: number
  frequency_penalty?: number
  logit_bias?: Record<string, number>
  user?: string
  /** Enable web search (OpenAI compatible) */
  web_search?: boolean
  /** Web search options (OpenAI compatible) */
  web_search_options?: {
    search_context_size?: 'low' | 'medium' | 'high'
    user_location?: {
      type: 'approximate'
      approximate?: {
        country?: string
        city?: string
        region?: string
      }
    }
  }
  /** Reasoning effort level (OpenAI compatible) - enables thinking mode */
  reasoning_effort?: string | boolean
  /** Reasoning effort level (camelCase, for AI SDK compatibility) */
  reasoningEffort?: string | boolean
  /** Explicit thinking switch (supported by providers such as Qwen AI) */
  enable_thinking?: boolean
  /** Maximum reasoning tokens (supported by providers such as Qwen AI) */
  thinking_budget?: number
  /** Enable deep research mode (GLM specific) */
  deep_research?: boolean
  /** Tools for function calling */
  tools?: ChatCompletionTool[]
  /** Tool choice strategy */
  tool_choice?: ChatCompletionToolChoice
  /** Disable parallel calls when a client/provider supports the OpenAI control. */
  parallel_tool_calls?: boolean
  /** Tool format - determines response format for tool calls */
  tool_format?: 'native' | 'json' | 'auto'
}

/**
 * Tool Definition for Function Calling
 */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters?: {
      type: 'object'
      properties: Record<
        string,
        {
          type: string
          description?: string
          enum?: string[]
        }
      >
      required?: string[]
    }
  }
}

/**
 * Chat Completions Response
 */
export interface ChatCompletionResponse {
  id: string
  object: 'chat.completion' | 'chat.completion.chunk'
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/**
 * Chat Completions Choice
 */
export interface ChatCompletionChoice {
  index: number
  message?: {
    role: 'assistant'
    content: string | null
    reasoning_content?: string
    tool_calls?: ToolCall[]
  }
  delta?: {
    role?: 'assistant'
    content?: string
    reasoning_content?: string
    tool_calls?: ToolCall[]
  }
  finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null
}

/**
 * Tool Call in Response
 */
export interface ToolCall {
  index?: number
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
  /** Raw text matched during prompt-based parsing; stripped before emitting. */
  rawText?: string
}

/**
 * Model Information
 */
export interface ModelInfo {
  id: string
  object: 'model'
  created: number
  owned_by: string
  permission?: ModelPermission[]
  root?: string
  parent?: string
}

/**
 * Model Permission
 */
export interface ModelPermission {
  id: string
  object: 'model_permission'
  created: number
  allow_create_engine: boolean
  allow_sampling: boolean
  allow_logprobs: boolean
  allow_search_indices: boolean
  allow_view: boolean
  allow_fine_tuning: boolean
  organization: string
  group: string
  is_blocking: boolean
}

/**
 * Models List Response
 */
export interface ModelsResponse {
  object: 'list'
  data: ModelInfo[]
}

/**
 * Proxy Request Context
 */
export interface ProxyContext {
  requestId: string
  /** Optional FluxMeld-local session backing this request. */
  sessionId?: string
  providerId?: string
  accountId?: string
  model: string
  actualModel?: string
  startTime: number
  isStream: boolean
  clientIP?: string
  /** Shared cancellation signal for client disconnects and the total request deadline. */
  signal?: AbortSignal
  /** Absolute wall-clock deadline shared by initial, repair, and retry attempts. */
  deadlineAt?: number
  /** Configured total request timeout, used for structured timeout errors. */
  timeoutMs?: number
}

/**
 * Request Forward Result
 */
export interface ForwardResult {
  success: boolean
  status?: number
  headers?: Record<string, string>
  body?: any
  stream?: NodeJS.ReadableStream
  skipTransform?: boolean
  error?: string
  latency?: number
  providerSessionId?: string
  parentMessageId?: string
  /** Internal normalized history used for an explicit FluxMeld session. */
  contextMessages?: ChatMessage[]
  /** Internal prompt-emulated tool failure context; never includes credentials. */
  toolCallingFailure?: {
    code:
      | 'missing_required_call'
      | 'invalid_arguments'
      | 'upstream_multiplexed_response'
      | 'upstream_incomplete_response'
    toolName?: string
    repairable: boolean
    diagnostics?: import('./toolCalling/types').ToolCallDiagnostics
    validationErrors?: string[]
    validationIssues?: import('./toolCalling/types').ToolArgumentValidationIssue[]
    repairAttempted?: boolean
    repairAttempts?: number
    /** Rejected arguments are fed only to the bounded repair turn; never log or return them. */
    rejectedArguments?: string
    /** Never logged or returned as diagnostics; used to preserve reasoning across bounded repair. */
    reasoningContent?: string
  }
  /** Structural-only telemetry for the single bounded tool-repair attempt. */
  toolRepair?: {
    attempted: true
    attempts: 1
    result: 'succeeded' | 'failed'
    firstValidationErrors: string[]
    finalValidationErrors: string[]
    firstValidationIssues: import('./toolCalling/types').ToolArgumentValidationIssue[]
    finalValidationIssues: import('./toolCalling/types').ToolArgumentValidationIssue[]
  }
  /** Account/provider that produced the final attempt after retry failover. */
  selection?: AccountSelection
}

/**
 * Account Selection Result
 */
export interface AccountSelection {
  account: import('../store/types').Account
  provider: import('../store/types').Provider
  actualModel: string
}

/**
 * SSE Event
 */
export interface SSEEvent {
  event?: string
  data: string
  id?: string
  retry?: number
}

/**
 * Proxy Statistics
 */
export interface ProxyStatistics {
  totalRequests: number
  successRequests: number
  failedRequests: number
  avgLatency: number
  requestsPerMinute: number
  activeConnections: number
  modelUsage: Record<string, number>
  providerUsage: Record<string, number>
  accountUsage: Record<string, number>
}

/**
 * Proxy Configuration
 */
export interface ProxyConfig {
  port: number
  host: string
  timeout: number
  retryCount: number
  retryDelay: number
  maxConnections: number
  enableCors: boolean
  corsOrigin: string | string[]
}
