import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createToolRepairLogData,
  createToolRepairRequest,
  createToolRepairTelemetry,
  enforceSingleToolRepairResult,
  mergeOriginalReasoningIntoRepairResponse,
  shouldAttemptToolRepair,
} from '../../src/main/proxy/toolCalling/repair.ts'
import type { ChatCompletionRequest, ForwardResult } from '../../src/main/proxy/types.ts'

const request: ChatCompletionRequest = {
  model: 'Qwen3.7-Max',
  messages: [{ role: 'user', content: 'Make a decision' }],
  stream: true,
  reasoning_effort: 'high',
  enable_thinking: true,
  thinking_budget: 4096,
  tool_choice: 'required',
  tools: [
    {
      type: 'function',
      function: {
        name: 'signal_wait',
        parameters: {
          type: 'object',
          properties: { pair: { type: 'string' } },
          required: ['pair'],
          additionalProperties: false,
        },
      },
    },
  ],
}

const invalidResult: ForwardResult = {
  success: false,
  status: 502,
  error: 'Upstream model returned invalid tool arguments for "signal_wait": $/pair is required',
  toolCallingFailure: {
    code: 'invalid_arguments',
    toolName: 'signal_wait',
    repairable: true,
  },
}

test('bounded repair includes required missing calls and remains single-attempt', () => {
  assert.equal(shouldAttemptToolRepair(invalidResult, request, false), true)
  assert.equal(shouldAttemptToolRepair(invalidResult, request, true), false)
  assert.equal(
    shouldAttemptToolRepair(
      {
        ...invalidResult,
        toolCallingFailure: { code: 'missing_required_call', repairable: false },
      },
      request,
      false,
    ),
    true,
  )
  assert.equal(
    shouldAttemptToolRepair(
      {
        ...invalidResult,
        toolCallingFailure: { code: 'missing_required_call', repairable: false },
      },
      { ...request, tool_choice: 'auto' },
      false,
    ),
    false,
  )
  const openCodeRefusal = {
    ...invalidResult,
    toolCallingFailure: {
      code: 'missing_required_call' as const,
      toolName: 'signal_wait',
      repairable: true,
      diagnostics: { toolRefusalDetected: true } as any,
    },
  }
  assert.equal(
    shouldAttemptToolRepair(openCodeRefusal, { ...request, tool_choice: 'auto' }, false),
    true,
  )
  assert.deepEqual(
    createToolRepairRequest({ ...request, tool_choice: 'auto' }, openCodeRefusal).tool_choice,
    { type: 'function', function: { name: 'signal_wait' } },
  )
  assert.equal(
    shouldAttemptToolRepair(
      {
        ...invalidResult,
        toolCallingFailure: { code: 'upstream_incomplete_response', repairable: true },
      },
      request,
      false,
    ),
    true,
  )
})

test('missing required-call repair explicitly requests the omitted call', () => {
  const repaired = createToolRepairRequest(request, {
    ...invalidResult,
    error: 'Upstream model did not return the required tool call',
    toolCallingFailure: {
      code: 'missing_required_call',
      repairable: false,
    },
  })

  assert.match(String(repaired.messages.at(-1)?.content), /did not contain the required tool call/)
  assert.deepEqual(repaired.tool_choice, request.tool_choice)
})

test('repair request preserves schema and forces one known tool with reasoning disabled', () => {
  const repaired = createToolRepairRequest(request, invalidResult)

  assert.equal(repaired.stream, false)
  assert.equal(repaired.reasoning_effort, 'off')
  assert.equal(repaired.reasoningEffort, 'off')
  assert.equal(repaired.enable_thinking, false)
  assert.equal(repaired.thinking_budget, undefined)
  assert.equal(repaired.temperature, 0)
  assert.equal(repaired.top_p, 1)
  assert.equal(repaired.n, 1)
  assert.equal(repaired.parallel_tool_calls, false)
  assert.deepEqual(repaired.tools, request.tools)
  assert.deepEqual(repaired.tool_choice, {
    type: 'function',
    function: { name: 'signal_wait' },
  })
  assert.match(String(repaired.messages.at(-1)?.content), /strict JSON Schema validation/)
  assert.match(
    String(repaired.messages.at(-1)?.content),
    /exactly one final FluxMeld tool_calls block/,
  )
})

test('repair prompt includes the rejected candidate, exact type issue, and complete target schema', () => {
  const targetTool = {
    type: 'function' as const,
    function: {
      name: 'signal_entry_short',
      description: 'Open short without dropping trading controls.',
      parameters: {
        type: 'object',
        properties: {
          pair: { type: 'string' },
          take_profit_ladder: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                pct: { type: 'number' },
                close_pct: { type: 'number' },
              },
              required: ['pct', 'close_pct'],
            },
          },
        },
        required: ['pair', 'take_profit_ladder'],
      },
    },
  }
  const otherTool = {
    type: 'function' as const,
    function: {
      name: 'signal_wait',
      parameters: { type: 'object', properties: {} },
    },
  }
  const rejectedArguments = JSON.stringify({
    pair: 'SKHYNIX/USDT:USDT',
    take_profit_ladder: '{"pct":0.015},{"pct":0.03}',
  })
  const productionRequest: ChatCompletionRequest = {
    ...request,
    model: 'GLM-5.2',
    messages: [...request.messages],
    tools: [targetTool, otherTool],
    reasoning_effort: false,
    stream: false,
    max_completion_tokens: 2048,
  }
  const productionFailure: ForwardResult = {
    success: false,
    status: 502,
    error:
      'Upstream model returned invalid tool arguments for "signal_entry_short": /take_profit_ladder must be array',
    toolCallingFailure: {
      code: 'invalid_arguments',
      toolName: 'signal_entry_short',
      repairable: true,
      rejectedArguments,
      validationErrors: ['/take_profit_ladder must be array (expected array, actual string)'],
      validationIssues: [
        {
          jsonPointer: '/take_profit_ladder',
          keyword: 'type',
          message: 'must be array',
          expected: 'array',
          actualType: 'string',
        },
      ],
    },
  }

  const repaired = createToolRepairRequest(productionRequest, productionFailure)
  const rejectedMessage = repaired.messages.at(-2)
  const prompt = String(repaired.messages.at(-1)?.content)

  assert.equal(repaired.tools?.length, 1)
  assert.equal(repaired.tools?.[0], targetTool)
  assert.equal(rejectedMessage?.role, 'assistant')
  assert.equal(rejectedMessage?.tool_calls?.[0].function.arguments, rejectedArguments)
  assert.match(prompt, /JSON Pointer: "\/take_profit_ladder"/)
  assert.match(prompt, /Expected: array/)
  assert.match(prompt, /Actual type: string/)
  assert.ok(prompt.includes(JSON.stringify(targetTool.function)))
  assert.equal(prompt.includes(JSON.stringify(otherTool.function)), false)
  assert.equal(productionRequest.messages.length, request.messages.length)
  assert.equal(productionRequest.tools?.length, 2)
})

test('repair result gate rejects multiple calls with 502 instead of dropping extras', () => {
  const doubleCall: ForwardResult = {
    success: true,
    status: 200,
    body: {
      choices: [
        {
          message: {
            tool_calls: [
              { type: 'function', function: { name: 'signal_wait', arguments: '{}' } },
              { type: 'function', function: { name: 'signal_wait', arguments: '{}' } },
            ],
          },
        },
      ],
    },
  }

  const rejected = enforceSingleToolRepairResult(doubleCall, 'signal_wait')

  assert.equal(rejected.success, false)
  assert.equal(rejected.status, 502)
  assert.equal(rejected.body, undefined)
  assert.equal(rejected.toolCallingFailure?.repairable, false)
  assert.match(rejected.error || '', /exactly one is required/)
  assert.equal(doubleCall.success, true)
  assert.equal(doubleCall.body.choices[0].message.tool_calls.length, 2)
})

test('repair telemetry logs attempt count, first/final errors, types, and result', () => {
  const firstFailure: ForwardResult = {
    ...invalidResult,
    toolCallingFailure: {
      ...invalidResult.toolCallingFailure!,
      validationErrors: ['/take_profit_ladder must be array'],
      validationIssues: [
        {
          jsonPointer: '/take_profit_ladder',
          keyword: 'type',
          message: 'must be array',
          expected: 'array',
          actualType: 'string',
        },
      ],
    },
  }
  const telemetry = createToolRepairTelemetry(firstFailure, {
    success: true,
    status: 200,
    body: { choices: [{ message: { tool_calls: [{}] } }] },
  })
  const logData = createToolRepairLogData(telemetry)

  assert.equal(logData.repair_attempted, true)
  assert.equal(logData.repair_attempts, 1)
  assert.equal(logData.first_validation_error, '/take_profit_ladder must be array')
  assert.equal(logData.final_validation_error, null)
  assert.equal(logData.repair_result, 'succeeded')
  assert.deepEqual(logData.first_field_types, [
    {
      json_pointer: '/take_profit_ladder',
      expected: 'array',
      actual_type: 'string',
      keyword: 'type',
    },
  ])
})

test('incomplete-response repair explains truncation and keeps strict controls', () => {
  const repaired = createToolRepairRequest(request, {
    ...invalidResult,
    toolCallingFailure: {
      code: 'upstream_incomplete_response',
      toolName: 'signal_wait',
      repairable: true,
    },
  })

  assert.match(String(repaired.messages.at(-1)?.content), /ended before its closing marker/)
  assert.deepEqual(repaired.tools, request.tools)
  assert.equal(repaired.reasoning_effort, 'off')
})

test('repair response preserves original enabled reasoning without mutation', () => {
  const body = {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'signal_wait', arguments: '{}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  }
  const merged = mergeOriginalReasoningIntoRepairResponse(
    body,
    {
      ...request,
      reasoning_effort: 'enabled',
    },
    'checked the schema',
  )

  assert.notEqual(merged, body)
  assert.equal(merged.choices[0].message.reasoning_content, 'checked the schema')
  assert.equal(body.choices[0].message.reasoning_content, undefined)
  assert.equal(
    mergeOriginalReasoningIntoRepairResponse(
      body,
      {
        ...request,
        reasoning_effort: 'off',
      },
      'must stay hidden',
    ),
    body,
  )
})
