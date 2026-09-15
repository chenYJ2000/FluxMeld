import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'
import type { Provider } from '../../src/main/store/types.ts'

const provider = {
  id: 'qwen-ai',
  name: 'Qwen AI',
  type: 'builtin',
  authType: 'jwt',
  apiEndpoint: 'https://chat.qwen.ai',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
} as Provider

const signalWaitTool = {
  type: 'function' as const,
  function: {
    name: 'signal_wait',
    description: 'Stay flat',
    parameters: {
      type: 'object',
      properties: {
        pair: { type: 'string' },
        reason: { type: 'string', minLength: 1 },
        confidence_score: { type: 'number', minimum: 1, maximum: 100 },
        cancel_pending_trigger: { type: 'boolean' },
        lean_direction: { type: 'string', enum: ['long', 'short', 'neutral'] },
        watch_price: { type: 'number', exclusiveMinimum: 0 },
        missing_confirmation: { type: 'string', minLength: 1 },
      },
      required: [
        'pair',
        'reason',
        'confidence_score',
        'cancel_pending_trigger',
        'lean_direction',
        'watch_price',
        'missing_confirmation',
      ],
      additionalProperties: false,
    },
  },
}

const traces = [
  { id: 'fbd21f4be58f45a293b7b008eeab055a', pair: 'MSFT/USDT:USDT', watchPrice: 430 },
  { id: 'dd1fe80072444461b46b50d204e0a505', pair: 'NVDA/USDT:USDT', watchPrice: 205.8 },
]

function request(): ChatCompletionRequest {
  return {
    model: 'Qwen3.7-Max',
    messages: [{ role: 'user', content: 'Return exactly one required PM decision.' }],
    tools: [signalWaitTool],
    tool_choice: 'required',
  }
}

function argumentsFor(trace: (typeof traces)[number]) {
  return {
    pair: trace.pair,
    reason: `Wait decision replay for trace ${trace.id}`,
    confidence_score: 82,
    cancel_pending_trigger: false,
    lean_direction: 'neutral',
    watch_price: trace.watchPrice,
    missing_confirmation: 'A confirmed reclaim or rejection at the watched level',
  }
}

function outputVariant(index: number, args: ReturnType<typeof argumentsFor>): string {
  const json = JSON.stringify(args)
  const parameters = Object.entries(args)
    .map(
      ([name, value]) =>
        `<|FLUXMELD|parameter name="${name}"><![CDATA[${typeof value === 'string' ? value : JSON.stringify(value)}]]></|FLUXMELD|parameter>`,
    )
    .join('')
  const variants = [
    `<|FLUXMELD|tool_calls><|FLUXMELD|invoke name="signal_wait">${parameters}</|FLUXMELD|invoke></|FLUXMELD|tool_calls>`,
    `\`\`\`xml\n<|FLUXMELD|tool_calls><|FLUXMELD|invoke name="signal_wait"><|FLUXMELD|parameter name="arguments"><![CDATA[${json}]]></|FLUXMELD|parameter></|FLUXMELD|invoke></|FLUXMELD|tool_calls>\n\`\`\``,
    `<tool_calls><invoke name="signal_wait">${json}</invoke></tool_calls>`,
    `<tool_calls><invoke name="signal_wait"><parameter name="pair">${args.pair}</parameter>${JSON.stringify({ ...args, pair: undefined }, (_key, value) => value)}</invoke></tool_calls>`,
    `[function_calls][call:signal_wait]${json}[/call][/function_calls]`,
    JSON.stringify({
      tool_calls: [
        {
          id: 'call_json',
          type: 'function',
          function: { name: 'signal_wait', arguments: args },
        },
      ],
    }),
  ]
  return variants[index % variants.length]
}

function streamArguments(content: string): string {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'qwen3.7-max',
  })
  const parser = new ToolStreamParser(transformed.plan)
  const baseChunk = {
    id: 'chatcmpl_trace',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'Qwen3.7-Max',
  }
  const chunks = []
  for (let offset = 0; offset < content.length; offset += 17) {
    chunks.push(...parser.push(content.slice(offset, offset + 17), baseChunk))
  }
  chunks.push(...parser.flush(baseChunk))
  const calls = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? [])
  assert.equal(calls.length, 1, `stream failed for ${content.slice(0, 120)}`)
  return calls[0].function.arguments
}

for (const trace of traces) {
  test(`PM trace ${trace.id} parses and validates consistently for 20 replays`, () => {
    const expected = argumentsFor(trace)

    for (let iteration = 0; iteration < 20; iteration += 1) {
      const content = outputVariant(iteration, expected)
      const engine = new ToolCallingEngine()
      const transformed = engine.transformRequest({
        request: request(),
        provider,
        actualModel: 'qwen3.7-max',
      })
      const result: any = {
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      }

      engine.applyNonStreamResponse(result, transformed.plan)
      const nonStreamArguments = result.choices[0].message.tool_calls[0].function.arguments
      const streamedArguments = streamArguments(content)

      assert.deepEqual(JSON.parse(nonStreamArguments), expected)
      assert.equal(streamedArguments, nonStreamArguments)
      assert.equal(nonStreamArguments.includes('FLUXMELD'), false)
    }
  })
}
