import type { ChatCompletionRequest, ForwardResult } from '../types.ts'
import type { ToolArgumentValidationIssue } from './types.ts'
import { isReasoningEnabled } from '../utils/reasoning.ts'

export const MAX_TOOL_REPAIR_ATTEMPTS = 1 as const

export function mergeOriginalReasoningIntoRepairResponse(
  body: any,
  request: ChatCompletionRequest,
  reasoningContent?: string,
): any {
  if (
    typeof reasoningContent !== 'string' ||
    !reasoningContent.trim() ||
    !isReasoningEnabled(
      request.reasoning_effort ?? request.reasoningEffort ?? request.enable_thinking,
    )
  )
    return body

  const choices = Array.isArray(body?.choices) ? body.choices : []
  const firstMessage = choices[0]?.message
  if (
    !firstMessage ||
    (typeof firstMessage.reasoning_content === 'string' && firstMessage.reasoning_content.trim())
  )
    return body

  return {
    ...body,
    choices: choices.map((choice: any, index: number) =>
      index === 0
        ? {
            ...choice,
            message: {
              ...choice.message,
              reasoning_content: reasoningContent,
            },
          }
        : choice,
    ),
  }
}

export function shouldAttemptToolRepair(
  result: ForwardResult,
  request: ChatCompletionRequest,
  alreadyAttempted: boolean,
): boolean {
  const failure = result.toolCallingFailure
  const isRequiredMissingCall =
    request.tool_choice === 'required' && failure?.code === 'missing_required_call'
  const isDetectedOpenCodeToolRefusal =
    failure?.code === 'missing_required_call' &&
    failure.diagnostics?.toolRefusalDetected === true &&
    Boolean(failure.toolName)
  const isExplicitOpenCodeToolRequest =
    failure?.code === 'missing_required_call' &&
    failure.diagnostics?.clientAdapterId === 'opencode' &&
    failure.diagnostics?.toolChoiceMode === 'forced' &&
    Boolean(failure.toolName ?? failure.diagnostics.forcedToolName)
  const isRepairableMalformedCall =
    (failure?.code === 'invalid_arguments' || failure?.code === 'upstream_incomplete_response') &&
    failure.repairable

  return (
    !alreadyAttempted &&
    !result.success &&
    Boolean(request.tools?.length) &&
    (isRequiredMissingCall ||
      isDetectedOpenCodeToolRefusal ||
      isExplicitOpenCodeToolRequest ||
      isRepairableMalformedCall)
  )
}

export function createToolRepairRequest(
  request: ChatCompletionRequest,
  result: ForwardResult,
): ChatCompletionRequest {
  const failedToolName = result.toolCallingFailure?.toolName
  const failedTool = failedToolName
    ? request.tools?.find((tool) => tool.function.name === failedToolName)
    : undefined
  const canForceTool = Boolean(failedToolName && failedTool)
  const allowedRepairTools = failedTool ? [failedTool] : [...(request.tools ?? [])]
  const reason = (result.error || 'arguments could not be parsed')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 1200)
  const failureDescription =
    result.toolCallingFailure?.code === 'upstream_incomplete_response'
      ? 'Your previous required tool call ended before its closing marker and was rejected.'
      : result.toolCallingFailure?.code === 'missing_required_call'
        ? 'Your previous response did not contain the required tool call and was rejected.'
        : 'Your previous tool call was rejected by strict JSON Schema validation.'
  const validationIssues = getValidationIssues(result)
  const validationSection =
    validationIssues.length > 0
      ? validationIssues
          .map((issue) =>
            [
              `JSON Pointer: ${JSON.stringify(issue.jsonPointer)}`,
              `Expected: ${issue.expected}`,
              `Actual type: ${issue.actualType}`,
              `Validation rule: ${issue.message}`,
            ].join('; '),
          )
          .join('\n')
      : `Validation error: ${reason}`
  const functionDefinitions = allowedRepairTools
    .map((tool) => JSON.stringify(tool.function))
    .join('\n')
  const requiredCall = failedToolName
    ? `Return exactly one call to ${JSON.stringify(failedToolName)} and no other function.`
    : 'Return exactly one call to one of the allowed functions and no other function.'
  const repairInstruction = [
    failureDescription,
    'Correct the rejected candidate; preserve all semantically valid trading values and fields.',
    'Emit each invalid field using the schema-required JSON type; the server will not coerce types.',
    'Do not delete or omit a field merely to bypass validation.',
    `Validation details (RFC 6901 JSON Pointers; an empty pointer means the document root):\n${validationSection}`,
    `Authoritative complete function definition(s), copied from the original request:\n${functionDefinitions}`,
    `This is bounded repair attempt 1 of ${MAX_TOOL_REPAIR_ATTEMPTS}.`,
    requiredCall,
    'Return exactly one final FluxMeld tool_calls block and nothing else.',
    'Do not reason, explain, use markdown fences, emit drafts, or omit required fields.',
    'Do not invent values: derive every argument from the original conversation.',
  ].join('\n\n')
  const rejectedArguments = result.toolCallingFailure?.rejectedArguments
  const rejectedCandidate =
    canForceTool && failedToolName && rejectedArguments
      ? [
          {
            role: 'assistant' as const,
            content: null,
            tool_calls: [
              {
                id: 'call_fluxmeld_rejected',
                type: 'function' as const,
                function: {
                  name: failedToolName,
                  arguments: rejectedArguments,
                },
              },
            ],
          },
        ]
      : []

  return {
    ...request,
    messages: [
      ...request.messages,
      ...rejectedCandidate,
      { role: 'user', content: repairInstruction },
    ],
    tools: allowedRepairTools,
    stream: false,
    n: 1,
    temperature: 0,
    top_p: 1,
    parallel_tool_calls: false,
    reasoning_effort: 'off',
    reasoningEffort: 'off',
    enable_thinking: false,
    thinking_budget: undefined,
    ...(canForceTool && failedToolName
      ? {
          tool_choice: { type: 'function', function: { name: failedToolName } },
        }
      : {}),
  }
}

/**
 * The normal schema validator has already run when this is called. This final
 * gate enforces repair-specific cardinality without dropping extra calls.
 */
export function enforceSingleToolRepairResult(
  result: ForwardResult,
  expectedToolName?: string,
): ForwardResult {
  if (!result.success) return result

  const choices = Array.isArray(result.body?.choices) ? result.body.choices : []
  const toolCalls = choices.flatMap((choice: any) =>
    Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [],
  )
  const actualToolName = toolCalls[0]?.function?.name
  const hasExpectedCardinality = toolCalls.length === 1
  const hasExpectedName = !expectedToolName || actualToolName === expectedToolName
  if (hasExpectedCardinality && hasExpectedName) return result

  const reason = !hasExpectedCardinality
    ? `bounded repair returned ${toolCalls.length} tool calls; exactly one is required`
    : `bounded repair returned function ${JSON.stringify(actualToolName)}; expected ${JSON.stringify(expectedToolName)}`
  const validationIssue: ToolArgumentValidationIssue = {
    jsonPointer: '/choices/0/message/tool_calls',
    keyword: hasExpectedCardinality ? 'const' : 'maxItems',
    message: reason,
    expected: expectedToolName ? `exactly one ${expectedToolName} call` : 'exactly one tool call',
    actualType: 'array',
  }

  return {
    ...result,
    success: false,
    status: 502,
    body: undefined,
    stream: undefined,
    error: `Upstream model returned invalid tool arguments for "${expectedToolName || actualToolName || 'unknown'}": ${reason}`,
    toolCallingFailure: {
      code: 'invalid_arguments',
      toolName: expectedToolName || actualToolName,
      repairable: false,
      validationErrors: [reason],
      validationIssues: [validationIssue],
    },
  }
}

export function createToolRepairTelemetry(
  firstResult: ForwardResult,
  finalResult: ForwardResult,
): NonNullable<ForwardResult['toolRepair']> {
  return {
    attempted: true,
    attempts: MAX_TOOL_REPAIR_ATTEMPTS,
    result: finalResult.success ? 'succeeded' : 'failed',
    firstValidationErrors: getValidationErrors(firstResult),
    finalValidationErrors: finalResult.success ? [] : getValidationErrors(finalResult),
    firstValidationIssues: getValidationIssues(firstResult),
    finalValidationIssues: finalResult.success ? [] : getValidationIssues(finalResult),
  }
}

export function createToolRepairLogData(
  telemetry: NonNullable<ForwardResult['toolRepair']>,
): Record<string, unknown> {
  return {
    repair_attempted: telemetry.attempted,
    repair_attempts: telemetry.attempts,
    first_validation_error: telemetry.firstValidationErrors[0] ?? null,
    final_validation_error: telemetry.finalValidationErrors[0] ?? null,
    first_validation_errors: [...telemetry.firstValidationErrors],
    final_validation_errors: [...telemetry.finalValidationErrors],
    first_field_types: formatFieldTypes(telemetry.firstValidationIssues),
    final_field_types: formatFieldTypes(telemetry.finalValidationIssues),
    repair_result: telemetry.result,
  }
}

function getValidationErrors(result: ForwardResult): string[] {
  const explicit =
    result.toolCallingFailure?.validationErrors ??
    result.toolCallingFailure?.diagnostics?.schemaValidationErrors
  if (explicit?.length) return [...explicit]
  return result.error ? [result.error] : []
}

function getValidationIssues(result: ForwardResult): ToolArgumentValidationIssue[] {
  const explicit =
    result.toolCallingFailure?.validationIssues ??
    result.toolCallingFailure?.diagnostics?.schemaValidationIssues
  return (explicit ?? []).map((issue) => ({ ...issue }))
}

function formatFieldTypes(issues: ToolArgumentValidationIssue[]): Array<Record<string, string>> {
  return issues.map((issue) => ({
    json_pointer: issue.jsonPointer,
    expected: issue.expected,
    actual_type: issue.actualType,
    keyword: issue.keyword,
  }))
}
