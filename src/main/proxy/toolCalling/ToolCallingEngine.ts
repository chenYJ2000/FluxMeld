import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import type { ChatCompletionRequest, ChatMessage, ToolCall } from '../types.ts'
import type { Provider } from '../../store/types.ts'
import {
  DEFAULT_TOOL_CALLING_CONFIG,
  normalizeToolCallingConfig,
  type ToolCallingConfig,
} from '../../../shared/toolCalling.ts'
import { getToolProtocol } from './protocols/index.ts'
import { hasFencedCodeBlock } from './protocols/shared.ts'
import { parseToolCallContent } from './responseParser.ts'
import { getToolClientAdapter, resolveToolClientAdapterForRequest } from './clientAdapters/index.ts'
import { buildToolCallingRuntimePlan } from './runtimePlan.ts'
import type {
  JsonRuntimeType,
  NormalizedToolDefinition,
  ToolArgumentValidationIssue,
  ToolCallingPlan,
  ToolCallingTransformResult,
  ToolProtocolId,
} from './types.ts'

export class ToolCallingResponseError extends Error {
  readonly status = 502
  readonly code: 'missing_required_call' | 'invalid_arguments'
  readonly diagnostics?: ToolCallingPlan['diagnostics']
  readonly validationErrors: string[]
  readonly validationIssues: ToolArgumentValidationIssue[]
  readonly toolName?: string
  readonly repairable: boolean
  /** Rejected arguments are private repair context and must never enter diagnostics/logs. */
  readonly rejectedArguments?: string
  /** Original upstream reasoning, retained only for the bounded repair response. */
  readonly reasoningContent?: string

  constructor(
    message: string,
    code: 'missing_required_call' | 'invalid_arguments' = 'invalid_arguments',
    diagnostics?: ToolCallingPlan['diagnostics'],
    validationErrors: string[] = [],
    toolName?: string,
    repairable: boolean = code === 'invalid_arguments',
    reasoningContent?: string,
    validationIssues: ToolArgumentValidationIssue[] = [],
    rejectedArguments?: string,
  ) {
    super(message)
    this.name = 'ToolCallingResponseError'
    this.code = code
    this.diagnostics = diagnostics
    this.validationErrors = [...validationErrors]
    this.validationIssues = validationIssues.map((issue) => ({ ...issue }))
    this.toolName = toolName
    this.repairable = repairable
    this.rejectedArguments = rejectedArguments
    this.reasoningContent = reasoningContent
  }
}

export class ToolCallingRequestError extends Error {
  readonly status = 400

  constructor(message: string) {
    super(message)
    this.name = 'ToolCallingRequestError'
  }
}

export function isToolCallingResponseErrorMessage(message?: string): boolean {
  return Boolean(
    message?.startsWith('Upstream model did not return the required tool call') ||
    message?.startsWith('Upstream model returned invalid tool arguments'),
  )
}

const MAX_SCHEMA_CACHE_ENTRIES = 256
const MAX_SCHEMA_CHARS = 100_000
const MANAGED_PROTOCOL_MARKER =
  /<\/?\|FLUXMELD\||<\/?(?:tool_calls|tool_use|invoke|parameter|parameters|arguments|antml:function_calls|antml:invoke|antml:parameters)\b|\[\/?function_calls\]|\[call:[^\]]+\]|\[\/call\]/i
const schemaValidator = new Ajv({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: false,
  useDefaults: false,
})
addFormats(schemaValidator)
const compiledSchemaCache = new Map<string, ValidateFunction>()

export class ToolCallingEngine {
  private readonly config: ToolCallingConfig

  constructor(config: Partial<ToolCallingConfig> = {}) {
    this.config = normalizeToolCallingConfig({
      ...DEFAULT_TOOL_CALLING_CONFIG,
      ...config,
      advanced: {
        ...DEFAULT_TOOL_CALLING_CONFIG.advanced,
        ...config.advanced,
      },
    })
  }

  transformRequest(input: {
    request: ChatCompletionRequest
    provider: Provider
    actualModel: string
    requestId?: string
  }): ToolCallingTransformResult {
    const { request, provider, actualModel, requestId } = input
    const adapterResolution = resolveToolClientAdapterForRequest(
      this.config.clientAdapterId,
      request,
    )
    const adapter = adapterResolution.adapter
    const normalizedClientRequest = adapter.normalizeRequest(request)
    const clientRequest =
      adapterResolution.resolvedBy === 'request_identity'
        ? {
            ...normalizedClientRequest,
            diagnostics: {
              ...normalizedClientRequest.diagnostics,
              configuredClientAdapterId: adapterResolution.configuredClientAdapterId,
              clientAdapterResolution: adapterResolution.resolvedBy,
            },
          }
        : normalizedClientRequest
    const plan = buildToolCallingRuntimePlan({
      requestId,
      providerId: provider.id,
      actualModel,
      model: request.model,
      config: this.config,
      clientRequest,
      providerToolCalling: provider.capabilities?.toolCalling,
    })
    if (plan.shouldParseResponse) {
      for (const tool of plan.tools) getToolArgumentValidator(tool)
    }
    const shouldInjectPrompt = plan.shouldInjectPrompt

    if (!shouldInjectPrompt) {
      return {
        messages: request.messages,
        tools: plan.mode === 'disabled' ? request.tools : undefined,
        plan,
      }
    }

    const prompt = renderPrompt(plan.protocol, plan.tools, this.config)
    const trailingToolInstruction = adapter.createTrailingToolInstruction?.(
      plan.protocol,
      plan.tools,
    )

    return {
      messages: [
        ...injectPrompt(request.messages, prompt),
        ...(trailingToolInstruction
          ? [{ role: 'user' as const, content: trailingToolInstruction }]
          : []),
      ],
      tools: undefined,
      plan,
    }
  }

  applyNonStreamResponse(result: any, plan: ToolCallingPlan): void {
    if (!plan.shouldParseResponse) return

    const message = result?.choices?.[0]?.message
    const rawContent = typeof message?.content === 'string' ? message.content : ''
    const rawResponsePreview = sanitizeDiagnosticPreview(
      rawContent ||
        JSON.stringify({
          content: message?.content ?? null,
          tool_calls: Array.isArray(message?.tool_calls) ? message.tool_calls : [],
        }),
    )

    try {
      if (!message) {
        this.assertRequiredToolCall(plan)
        return
      }

      // Some upstreams unexpectedly return genuine OpenAI tool_calls even
      // though the request was prompt-emulated. Prefer and validate them no
      // matter whether a text/reasoning field is also present.
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        message.tool_calls = validateAndSanitizeToolCalls(message.tool_calls, plan)
        result.choices[0].finish_reason = 'tool_calls'
        return
      }

      if (typeof message.content !== 'string') {
        this.assertRequiredToolCall(plan)
        return
      }

      const responseAdapter = getToolClientAdapter(plan.clientAdapterId)
      const cleanedResponseContent = responseAdapter.stripToolRefusalPreamble?.(
        message.content,
        plan.allowedToolNames,
      )
      if (cleanedResponseContent) {
        message.content = cleanedResponseContent
      }
      const refusedTool = responseAdapter.detectToolRefusal?.(
        message.content,
        plan.allowedToolNames,
      )
      if (refusedTool) {
        plan.diagnostics = {
          ...plan.diagnostics,
          toolRefusalDetected: true,
          refusedToolName: sanitizeToolName(refusedTool.toolName),
        }
        throw new ToolCallingResponseError(
          `Upstream model refused declared tool "${sanitizeToolName(refusedTool.toolName)}" instead of emitting a tool call`,
          'missing_required_call',
          plan.diagnostics,
          [],
          refusedTool.toolName,
          true,
        )
      }

      const parseResult = parseSelectedProtocol(message.content, plan)
      plan.diagnostics = {
        ...plan.diagnostics,
        parserFormat: parseResult.protocol,
        detectedProtocols: parseResult.detectedProtocols,
        parsedToolCallCount: parseResult.toolCalls.length,
        invalidToolNames: [...parseResult.invalidToolNames],
        malformedToolNames: [...(parseResult.malformedToolNames ?? [])],
        malformedReason: parseResult.malformedReason,
        fencedBlockDetected: hasFencedCodeBlock(message.content),
        rawContentPreview: rawResponsePreview,
        ...(this.config.diagnosticsEnabled
          ? {
              rawMatchPreviews: parseResult.rawMatches.map((raw) =>
                sanitizeDiagnosticPreview(raw, 800),
              ),
              parsedArgumentsPreview: parseResult.toolCalls.map((call) => ({
                name: sanitizeToolName(call.function.name),
                arguments: sanitizeDiagnosticPreview(call.function.arguments, 1200),
              })),
            }
          : {}),
      }

      if (parseResult.toolCalls.length === 0) {
        this.assertRequiredToolCall(
          plan,
          parseResult.invalidToolNames,
          parseResult.malformedReason,
          parseResult.malformedToolNames,
        )
        return
      }

      const toolCalls = validateAndSanitizeToolCalls(parseResult.toolCalls, plan)
      message.content = parseResult.content || null
      message.tool_calls = toolCalls
      result.choices[0].finish_reason = 'tool_calls'
    } catch (error) {
      if (!(error instanceof ToolCallingResponseError)) throw error

      const diagnostics = {
        ...plan.diagnostics,
        ...(error.validationErrors.length > 0
          ? { schemaValidationErrors: [...error.validationErrors] }
          : {}),
        ...(error.validationIssues.length > 0
          ? { schemaValidationIssues: error.validationIssues.map((issue) => ({ ...issue })) }
          : {}),
        ...(error.message.includes('internal protocol markers')
          ? { wrapperLeakDetected: true }
          : {}),
        rawContentPreview: rawResponsePreview,
      }
      plan.diagnostics = diagnostics
      const reasoningContent =
        typeof message?.reasoning_content === 'string' && message.reasoning_content.trim()
          ? message.reasoning_content
          : error.reasoningContent
      throw new ToolCallingResponseError(
        error.message,
        error.code,
        diagnostics,
        error.validationErrors,
        error.toolName,
        error.repairable,
        reasoningContent,
        error.validationIssues,
        error.rejectedArguments,
      )
    }
  }

  private assertRequiredToolCall(
    plan: ToolCallingPlan,
    invalidToolNames: string[] = [],
    malformedReason?: string,
    malformedToolNames: string[] = [],
  ): void {
    if (plan.toolChoiceMode !== 'required' && plan.toolChoiceMode !== 'forced') return

    if (malformedToolNames.length > 0) {
      const toolName = malformedToolNames[0]
      throw new ToolCallingResponseError(
        `Upstream model returned invalid tool arguments for "${sanitizeToolName(toolName)}": ${malformedReason || 'arguments could not be parsed'}`,
        'invalid_arguments',
        undefined,
        malformedReason ? [malformedReason] : [],
        toolName,
        true,
      )
    }

    const details = [
      invalidToolNames.length > 0 ? `invalid tools: ${invalidToolNames.join(', ')}` : undefined,
      malformedReason,
    ]
      .filter(Boolean)
      .join('; ')
    const suffix = details ? ` (${details})` : ''
    throw new ToolCallingResponseError(
      `Upstream model did not return the required tool call${suffix}`,
      'missing_required_call',
      undefined,
      [],
      plan.forcedToolName,
      Boolean(plan.forcedToolName),
    )
  }
}

export function validateAndSanitizeToolCalls(
  toolCalls: ToolCall[],
  plan: ToolCallingPlan,
): ToolCall[] {
  const definitions = new Map(plan.tools.map((tool) => [tool.name, tool]))

  return toolCalls.map((toolCall) => {
    const publicToolCall = stripInternalToolMetadata(toolCall)
    const toolName = publicToolCall.function?.name
    const definition = definitions.get(toolName)
    if (!definition) {
      throwInvalidToolArguments(toolName || 'unknown', 'tool is not allowed by this request', false)
    }

    const rawArguments = publicToolCall.function?.arguments
    if (typeof rawArguments !== 'string') {
      throwInvalidToolArguments(toolName, 'arguments must be a JSON string', true, [
        createValidationIssue('', 'type', 'must be a JSON string', 'JSON string', rawArguments),
      ])
    }
    if (MANAGED_PROTOCOL_MARKER.test(rawArguments)) {
      throwInvalidToolArguments(
        toolName,
        'arguments contain internal protocol markers',
        true,
        [],
        rawArguments,
      )
    }

    let argumentsValue: unknown
    try {
      argumentsValue = JSON.parse(rawArguments)
    } catch {
      throwInvalidToolArguments(
        toolName,
        'arguments are not valid JSON',
        true,
        [
          createValidationIssue(
            '',
            'parse',
            'must be valid JSON',
            'valid JSON object',
            rawArguments,
          ),
        ],
        rawArguments,
      )
    }

    if (!isPlainObject(argumentsValue)) {
      throwInvalidToolArguments(
        toolName,
        'arguments must decode to a JSON object',
        true,
        [createValidationIssue('', 'type', 'must be object', 'object', argumentsValue)],
        rawArguments,
      )
    }

    const validate = getToolArgumentValidator(definition)
    if (!validate(argumentsValue)) {
      const validationIssues = buildSchemaValidationIssues(validate.errors, argumentsValue)
      throwInvalidToolArguments(
        toolName,
        formatSchemaErrors(validationIssues),
        true,
        validationIssues,
        rawArguments,
      )
    }

    return publicToolCall
  })
}

function getToolArgumentValidator(tool: NormalizedToolDefinition): ValidateFunction {
  const rawSchema = tool.parameters ?? {}
  if (rawSchema.type !== undefined && rawSchema.type !== 'object') {
    throwInvalidToolSchema(tool.name, 'root type must be "object"')
  }
  const { $id, $schema, ...schemaWithoutMetadata } = rawSchema
  void $id
  void $schema
  const normalizedSchema = {
    ...schemaWithoutMetadata,
    type: 'object',
  }

  let cacheKey: string
  try {
    cacheKey = JSON.stringify(normalizedSchema)
  } catch {
    throwInvalidToolSchema(tool.name, 'schema is not serializable')
  }
  if (cacheKey.length > MAX_SCHEMA_CHARS) {
    throwInvalidToolSchema(tool.name, `schema exceeds ${MAX_SCHEMA_CHARS} characters`)
  }

  const cached = compiledSchemaCache.get(cacheKey)
  if (cached) {
    compiledSchemaCache.delete(cacheKey)
    compiledSchemaCache.set(cacheKey, cached)
    return cached
  }

  let compiled: ValidateFunction
  try {
    compiled = schemaValidator.compile(normalizedSchema)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown schema error'
    throwInvalidToolSchema(tool.name, message)
  }

  compiledSchemaCache.set(cacheKey, compiled)
  if (compiledSchemaCache.size > MAX_SCHEMA_CACHE_ENTRIES) {
    const oldestKey = compiledSchemaCache.keys().next().value
    if (oldestKey !== undefined) compiledSchemaCache.delete(oldestKey)
  }
  return compiled
}

function buildSchemaValidationIssues(
  errors: ErrorObject[] | null | undefined,
  argumentsValue: Record<string, unknown>,
): ToolArgumentValidationIssue[] {
  return (errors ?? []).slice(0, 6).map((error) => {
    const params = error.params as Record<string, unknown>
    const relatedProperty =
      error.keyword === 'required'
        ? String(params.missingProperty ?? '')
        : error.keyword === 'additionalProperties'
          ? String(params.additionalProperty ?? '')
          : ''
    const jsonPointer = relatedProperty
      ? appendJsonPointer(error.instancePath, relatedProperty)
      : error.instancePath
    const actualValue =
      error.keyword === 'required'
        ? MISSING_JSON_VALUE
        : getJsonPointerValue(argumentsValue, jsonPointer)

    return {
      jsonPointer,
      keyword: error.keyword,
      message: error.message || error.keyword,
      expected: getExpectedDescription(error),
      actualType: getJsonRuntimeType(actualValue),
    }
  })
}

function formatSchemaErrors(issues: ToolArgumentValidationIssue[]): string {
  if (issues.length === 0) return 'arguments do not match the declared JSON Schema'

  return issues
    .map((issue) => {
      const pointer = issue.jsonPointer || '(document root)'
      return `${pointer} ${issue.message} (expected ${issue.expected}, actual ${issue.actualType})`
    })
    .join('; ')
}

function createValidationIssue(
  jsonPointer: string,
  keyword: string,
  message: string,
  expected: string,
  actualValue: unknown,
): ToolArgumentValidationIssue {
  return {
    jsonPointer,
    keyword,
    message,
    expected,
    actualType: getJsonRuntimeType(actualValue),
  }
}

const MISSING_JSON_VALUE = Symbol('missing-json-value')

function appendJsonPointer(base: string, property: string): string {
  const escaped = property.replace(/~/g, '~0').replace(/\//g, '~1')
  return `${base}/${escaped}`
}

function getJsonPointerValue(root: unknown, pointer: string): unknown | typeof MISSING_JSON_VALUE {
  if (!pointer) return root
  if (!pointer.startsWith('/')) return MISSING_JSON_VALUE

  let current: unknown = root
  for (const encodedToken of pointer.slice(1).split('/')) {
    const token = encodedToken.replace(/~1/g, '/').replace(/~0/g, '~')
    if (
      typeof current !== 'object' ||
      current === null ||
      !Object.prototype.hasOwnProperty.call(current, token)
    )
      return MISSING_JSON_VALUE
    current = (current as Record<string, unknown>)[token]
  }
  return current
}

function getExpectedDescription(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>
  switch (error.keyword) {
    case 'type':
      return String(params.type ?? 'declared JSON type')
    case 'required':
      return 'present property'
    case 'additionalProperties':
      return 'property to be absent'
    case 'enum':
      return 'one of the declared enum values'
    case 'const':
      return 'the declared constant value'
    case 'format':
      return `format ${String(params.format ?? 'declared by schema')}`
    default:
      return error.message || error.keyword
  }
}

function getJsonRuntimeType(value: unknown | typeof MISSING_JSON_VALUE): JsonRuntimeType {
  if (value === MISSING_JSON_VALUE || value === undefined) return 'missing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'unknown'
}

function throwInvalidToolArguments(
  toolName: string,
  reason: string,
  repairable: boolean = true,
  validationIssues: ToolArgumentValidationIssue[] = [],
  rejectedArguments?: string,
): never {
  throw new ToolCallingResponseError(
    `Upstream model returned invalid tool arguments for "${sanitizeToolName(toolName)}": ${reason}`,
    'invalid_arguments',
    undefined,
    [reason],
    toolName,
    repairable,
    undefined,
    validationIssues,
    rejectedArguments,
  )
}

function throwInvalidToolSchema(toolName: string, reason: string): never {
  throw new ToolCallingRequestError(
    `Invalid JSON Schema for tool "${sanitizeToolName(toolName)}": ${reason}`,
  )
}

function sanitizeToolName(toolName: string): string {
  return toolName.replace(/[\r\n\t]/g, ' ').slice(0, 128)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripInternalToolMetadata(toolCall: ToolCall): ToolCall {
  const { rawText, ...publicToolCall } = toolCall as ToolCall & { rawText?: string }
  void rawText
  return publicToolCall
}

function renderPrompt(
  protocol: ToolProtocolId,
  tools: NormalizedToolDefinition[],
  config: ToolCallingConfig,
): string {
  const prompt = getToolProtocol(protocol).renderPrompt(tools)
  const customPromptTemplate = config.diagnosticsEnabled
    ? config.advanced.customPromptTemplate
    : undefined
  if (!customPromptTemplate) return prompt

  return customPromptTemplate
    .replace(/\{\{tools\}\}/g, prompt)
    .replace(/\{\{tool_names\}\}/g, tools.map((tool) => tool.name).join(', '))
    .replace(/\{\{format\}\}/g, protocol)
}

function injectPrompt(messages: ChatMessage[], prompt: string): ChatMessage[] {
  const [first, ...rest] = messages
  if (first?.role === 'system' && typeof first.content === 'string') {
    return [{ ...first, content: `${first.content}\n\n${prompt}` }, ...rest]
  }

  return [{ role: 'system', content: prompt }, ...messages]
}

function parseSelectedProtocol(content: string, plan: ToolCallingPlan) {
  return parseToolCallContent(content, plan)
}

function sanitizeDiagnosticPreview(value: string, maxChars: number = 2400): string {
  const redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(
      /("?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|set-cookie|password|session[_-]?token|token)"?\s*[:=]\s*)"?[^",}\]\s]+"?/gi,
      '$1"[REDACTED]"',
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  return redacted.length <= maxChars
    ? redacted
    : `${redacted.slice(0, maxChars)}...[truncated ${redacted.length - maxChars} chars]`
}
