import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  buildQwenAiFeatureConfig,
  buildQwenAiPrompt,
  QwenAiAdapter,
  QwenAiStreamHandler,
  resolveQwenAiGenerationSettings,
} from '../../src/main/proxy/adapters/qwen-ai.ts'

function sse(events: Array<unknown | '[DONE]'>): Readable {
  return Readable.from(
    events.map(event => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`)
  )
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of stream) {
    chunks.push(String(chunk))
  }
  return chunks.join('')
}

test('Qwen AI applies the effective request deadline to chat creation and completion', async () => {
  const adapter = new QwenAiAdapter({
    id: 'qwen-ai',
    name: 'Qwen AI',
    apiEndpoint: 'https://chat.qwen.ai',
    modelMappings: {},
  } as any, {
    id: 'account-1',
    credentials: { token: 'test-token' },
  } as any)
  const requestConfigs: any[] = []
  const controller = new AbortController()

  ;(adapter as any).axiosInstance = {
    post: async (url: string, _payload: unknown, config: unknown) => {
      requestConfigs.push(config)
      return url.endsWith('/chats/new')
        ? { status: 200, data: { data: { id: 'chat-1' } } }
        : { status: 200, data: Readable.from([]) }
    },
  }

  await adapter.chatCompletion({
    model: 'Qwen3.6-Plus',
    messages: [{ role: 'user', content: 'Inspect the project.' }],
  }, {
    signal: controller.signal,
    timeoutMs: 180_000,
  })

  assert.equal(requestConfigs.length, 2)
  assert.deepEqual(
    requestConfigs.map((config) => config.timeout),
    [180_000, 180_000],
  )
  assert.ok(requestConfigs.every((config) => config.signal === controller.signal))
})

test('Qwen AI non-stream returns answer content and real upstream usage', async () => {
  const handler = new QwenAiStreamHandler('qwen3.6-plus')
  const response = await handler.handleNonStream(sse([
    { 'response.created': { response_id: 'response-1' } },
    {
      choices: [{ delta: { role: 'assistant', content: 'OK', phase: 'answer', status: 'typing' } }],
      usage: { input_tokens: 828, output_tokens: 1, total_tokens: 829 },
    },
    { choices: [{ delta: { content: '', phase: 'answer', status: 'finished' } }] },
  ]))

  assert.equal(response.id, 'response-1')
  assert.equal(response.choices[0].message.content, 'OK')
  assert.deepEqual(response.usage, {
    prompt_tokens: 828,
    completion_tokens: 1,
    total_tokens: 829,
  })
})

test('Qwen AI non-stream rejects a 200 stream with no assistant content', async () => {
  const handler = new QwenAiStreamHandler('qwen3.6-plus')

  await assert.rejects(
    handler.handleNonStream(sse([
      { 'response.created': { response_id: 'response-empty' } },
      { choices: [{ delta: { content: '', phase: 'answer', status: 'finished' } }] },
    ])),
    /completed without assistant content/
  )
})

test('Qwen AI non-stream surfaces an error embedded in an HTTP 200 SSE response', async () => {
  const handler = new QwenAiStreamHandler('qwen3.6-plus')

  await assert.rejects(
    handler.handleNonStream(sse([{ success: false, code: 'MODEL_BUSY', message: 'Model is busy' }])),
    /Qwen upstream error: Model is busy/
  )
})

test('Qwen AI stream returns content, finish reason, and real usage', async () => {
  const handler = new QwenAiStreamHandler('qwen3.6-plus')
  const output = await collect(await handler.handleStream(sse([
    { 'response.created': { response_id: 'response-stream' } },
    {
      choices: [{ delta: { role: 'assistant', content: 'OK', phase: 'answer', status: 'typing' } }],
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
    },
    { choices: [{ delta: { content: '', phase: 'answer', status: 'finished' } }] },
  ])))

  assert.match(output, /"content":"OK"/)
  assert.match(output, /"finish_reason":"stop"/)
  assert.match(output, /"prompt_tokens":10/)
  assert.match(output, /data: \[DONE\]/)
})

test('Qwen AI omits usage when upstream does not provide complete token counts', async () => {
  const handler = new QwenAiStreamHandler('Qwen3.7-Max')
  handler.setChatId('chat-no-usage')
  const upstream = sse([
    { 'response.created': { response_id: 'resp-no-usage' } },
    { choices: [{ delta: { phase: 'answer', content: 'ok', status: 'finished' } }] },
  ])

  const response = await handler.handleNonStream(upstream)

  assert.equal('usage' in response, false)
})

test('Qwen AI stream cleanup callback is installed before a one-chunk response finishes', async () => {
  const cleanedChats: string[] = []
  const handler = new QwenAiStreamHandler('qwen3.6-plus', (chatId) => {
    cleanedChats.push(chatId)
  })
  handler.setChatId('chat-fast-finish')

  const payload = [
    { 'response.created': { response_id: 'response-fast-finish' } },
    { choices: [{ delta: { content: 'OK', phase: 'answer', status: 'typing' } }] },
    { choices: [{ delta: { content: '', phase: 'answer', status: 'finished' } }] },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')

  const output = await collect(await handler.handleStream(Readable.from([payload])))
  assert.match(output, /"content":"OK"/)
  assert.deepEqual(cleanedChats, ['chat-fast-finish'])
})

test('Qwen AI stream rejects before returning a fake empty success', async () => {
  const handler = new QwenAiStreamHandler('qwen3.6-plus')

  await assert.rejects(
    handler.handleStream(sse([
      { 'response.created': { response_id: 'response-stream-empty' } },
      { choices: [{ delta: { content: '', phase: 'answer', status: 'finished' } }] },
    ])),
    /completed without assistant content/
  )
})

test('Qwen AI accepts OpenAI-style deltas without a phase field', async () => {
  const handler = new QwenAiStreamHandler('qwen3.6-plus')
  const response = await handler.handleNonStream(sse([
    { choices: [{ delta: { role: 'assistant', content: 'phase-less', status: 'typing' } }] },
    { choices: [{ delta: { content: '', status: 'finished' } }] },
  ]))

  assert.equal(response.choices[0].message.content, 'phase-less')
  assert.equal(handler.getUpstreamCompletionState(), 'complete')
})

test('Qwen AI records an output-limited partial answer separately from completion', async () => {
  const handler = new QwenAiStreamHandler('Qwen3.7-Max', undefined, {
    maxCompletionTokens: 5,
  })
  const response = await handler.handleNonStream(sse([{
    choices: [{ delta: { content: '<|CHAT', phase: 'answer', status: 'typing' } }],
    usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 },
  }]))

  assert.equal(response.choices[0].finish_reason, 'length')
  assert.equal(handler.getUpstreamCompletionState(), 'output_limit')
})

test('Qwen AI records transport-ended partial output as incomplete', async () => {
  const handler = new QwenAiStreamHandler('Qwen3.7-Max')
  const response = await handler.handleNonStream(sse([{
    choices: [{ delta: { content: '<|CHAT', phase: 'answer', status: 'typing' } }],
  }]))

  assert.equal(response.choices[0].message.content, '<|CHAT')
  assert.equal(handler.getUpstreamCompletionState(), 'incomplete')
})

test('Qwen AI discards a superseded partial answer when upstream restarts the response', async () => {
  const handler = new QwenAiStreamHandler('Qwen3.7-Max')
  const response = await handler.handleNonStream(sse([
    { 'response.created': { response_id: 'response-first' } },
    {
      choices: [{
        delta: {
          content: '<|FLUXMELD|tool_calls><|FLUXMELD|invoke name="signal_wait"',
          phase: 'answer',
          status: 'typing',
        },
      }],
    },
    { 'response.created': { response_id: 'response-replacement' } },
    {
      choices: [{
        delta: { content: 'replacement answer', phase: 'answer', status: 'typing' },
      }],
    },
    {
      choices: [{ delta: { content: '', phase: 'answer', status: 'finished' } }],
    },
  ]))

  assert.equal(response.id, 'response-replacement')
  assert.equal(response.choices[0].message.content, 'replacement answer')
  assert.equal(handler.getUpstreamEventSummary().responseCreatedCount, 2)
})

test('Qwen AI reconstructs unidentified multiplexed candidates without mixing their chunks', async () => {
  const handler = new QwenAiStreamHandler('Qwen3.7-Max')
  const response = await handler.handleNonStream(sse([
    { 'response.created': { response_id: 'response-a' } },
    { 'response.created': { response_id: 'response-b' } },
    { choices: [{ delta: { content: 'A1', phase: 'answer', status: 'typing' } }] },
    { choices: [{ delta: { content: 'B1', phase: 'answer', status: 'typing' } }] },
    { choices: [{ delta: { content: 'A2', phase: 'answer', status: 'typing' } }] },
    { choices: [{ delta: { content: 'B2', phase: 'answer', status: 'typing' } }] },
    { choices: [{ delta: { content: '', phase: 'answer', status: 'finished' } }] },
  ]))

  assert.equal(response.choices[0].message.content, 'A1B1A2B2')
  assert.deepEqual(handler.getAlternativeAnswerContents(), ['A1A2', 'B1B2'])
  assert.deepEqual(
    handler.getUpstreamEventSummary().responseCreatedChoiceOffsets,
    [0, 0],
  )
})

test('Qwen AI preserves assistant tool calls and tool validation feedback', () => {
  const prompt = buildQwenAiPrompt([
    { role: 'system', content: 'Choose exactly one trading tool.' },
    { role: 'user', content: 'Analyze TSLA.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_0',
        function: { name: 'signal_wait', arguments: '{"pair":"TSLA"}' },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_0',
      content: 'Validation failed: confidence is required.',
    },
  ])

  assert.match(prompt, /Choose exactly one trading tool/)
  assert.match(prompt, /User: Analyze TSLA/)
  assert.match(prompt, /signal_wait/)
  assert.match(prompt, /tool_result tool_call_id="call_0"/)
  assert.match(prompt, /confidence is required/)
})

test('Qwen AI keeps tool history in the selected bracket protocol', () => {
  const prompt = buildQwenAiPrompt([
    { role: 'system', content: 'Use the supplied tools.' },
    { role: 'user', content: 'Inspect the project.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_0',
        function: { name: 'glob', arguments: '{"pattern":"**/*"}' },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_0',
      content: 'src/main/index.ts',
    },
  ], 'managed_bracket')

  assert.match(prompt, /\[function_calls\]/)
  assert.match(prompt, /\[call:glob\]/)
  assert.match(prompt, /\[TOOL_RESULT for call_0\]/)
  assert.doesNotMatch(prompt, /<\|FLUXMELD\|tool_calls>/)
})

test('Qwen AI resolves fast mode without leaking a truthy disabled effort', () => {
  const settings = resolveQwenAiGenerationSettings({
    reasoning_effort: 'none',
    thinking_budget: 2048,
    max_tokens: 300,
    max_completion_tokens: 900,
  })

  assert.deepEqual(settings, {
    enableThinking: false,
    maxTokens: 300,
    maxCompletionTokens: 900,
  })
  assert.deepEqual(buildQwenAiFeatureConfig(settings), {
    thinking_enabled: false,
    output_schema: 'phase',
    research_mode: 'normal',
    auto_thinking: false,
    thinking_format: 'summary',
    auto_search: false,
  })
})

test('Qwen AI maps reasoning effort to bounded thinking budgets', () => {
  assert.equal(
    resolveQwenAiGenerationSettings({ reasoning_effort: 'low' }).thinkingBudget,
    1024
  )
  assert.equal(
    resolveQwenAiGenerationSettings({ reasoning_effort: 'medium' }).thinkingBudget,
    4096
  )
  assert.equal(
    resolveQwenAiGenerationSettings({ reasoning_effort: 'high' }).thinkingBudget,
    8192
  )
  assert.equal(
    resolveQwenAiGenerationSettings({ reasoning_effort: 'enabled' }).thinkingBudget,
    2048
  )
  assert.equal(
    resolveQwenAiGenerationSettings({
      reasoning_effort: 'enabled',
      max_completion_tokens: 1024,
    }).thinkingBudget,
    768
  )
})

test('Qwen AI explicit budget overrides effort and model suffix controls thinking', () => {
  const thinking = resolveQwenAiGenerationSettings({
    reasoning_effort: 'high',
    thinking_budget: 1536,
  }, true)
  assert.deepEqual(thinking, {
    enableThinking: true,
    thinkingBudget: 1536,
  })

  const fast = resolveQwenAiGenerationSettings({
    reasoning_effort: 'high',
    thinking_budget: 1536,
  }, false)
  assert.deepEqual(fast, { enableThinking: false })
})

test('Qwen AI rejects malformed generation limits', () => {
  assert.throws(
    () => resolveQwenAiGenerationSettings({ thinking_budget: 0 }),
    /thinking_budget must be a positive integer/
  )
  assert.throws(
    () => resolveQwenAiGenerationSettings({ max_completion_tokens: 1.5 }),
    /max_completion_tokens must be a positive integer/
  )
  assert.throws(
    () => resolveQwenAiGenerationSettings({ reasoning_effort: 'turbo' }),
    /Unsupported reasoning_effort/
  )
})

test('Qwen AI non-stream stops at the first total-usage checkpoint over the limit', async () => {
  const handler = new QwenAiStreamHandler('qwen3.6-plus', undefined, {
    maxCompletionTokens: 5,
  })
  const response = await handler.handleNonStream(sse([
    {
      choices: [{ delta: { content: 'kept', phase: 'answer', status: 'typing' } }],
      usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 },
    },
    {
      choices: [{ delta: { content: '-ignored', phase: 'answer', status: 'finished' } }],
      usage: { input_tokens: 10, output_tokens: 14, total_tokens: 24 },
    },
  ]))

  assert.equal(response.choices[0].message.content, 'kept')
  assert.equal(response.choices[0].finish_reason, 'length')
  assert.equal(response.usage.completion_tokens, 6)
})

test('Qwen AI stream enforces answer-only max_tokens at usage checkpoints', async () => {
  const handler = new QwenAiStreamHandler('qwen3.6-plus', undefined, {
    maxTokens: 5,
  })
  const output = await collect(await handler.handleStream(sse([
    {
      choices: [{ delta: { content: 'kept', phase: 'answer', status: 'typing' } }],
      usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 },
    },
    {
      choices: [{ delta: { content: '-ignored', phase: 'answer', status: 'finished' } }],
      usage: { input_tokens: 10, output_tokens: 14, total_tokens: 24 },
    },
  ])))

  assert.match(output, /"content":"kept"/)
  assert.doesNotMatch(output, /ignored/)
  assert.match(output, /"finish_reason":"length"/)
})
