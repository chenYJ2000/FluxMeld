import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_CONTEXT_MANAGEMENT_CONFIG,
  SlidingWindowStrategy,
  SummaryStrategy,
  createContextManagementService,
} from '../../src/main/proxy/services/contextManagementService.ts'
import {
  assistantMessageFromSSE,
  mergeSessionMessages,
} from '../../src/main/proxy/services/sessionContextService.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

const toolCall = {
  id: 'call_weather',
  type: 'function' as const,
  function: {
    name: 'get_weather',
    arguments: '{"city":"Shanghai"}',
  },
}

test('context management summarizes before it applies the sliding window', async () => {
  assert.deepEqual(DEFAULT_CONTEXT_MANAGEMENT_CONFIG.executionOrder, [
    'summary',
    'slidingWindow',
    'tokenLimit',
  ])

  const messages: ChatMessage[] = [
    { role: 'system', content: 'Follow the user preferences.' },
    { role: 'user', content: 'What is the weather?' },
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    { role: 'tool', content: '22°C and sunny', tool_call_id: 'call_weather' },
    { role: 'assistant', content: 'It is sunny and 22°C.' },
    { role: 'user', content: 'What should I wear?' },
  ]
  let summarizedMessages: ChatMessage[] = []
  const service = createContextManagementService(
    {
      enabled: true,
      strategies: {
        summary: { enabled: true, keepRecentMessages: 2 },
        slidingWindow: { enabled: true, maxMessages: 4 },
        tokenLimit: { enabled: false, maxTokens: 4000 },
      },
      executionOrder: ['summary', 'slidingWindow', 'tokenLimit'],
    },
    async (oldMessages) => {
      summarizedMessages = oldMessages
      return 'The assistant called get_weather and learned it was sunny.'
    },
  )

  const result = await service.process(messages)

  assert.equal(summarizedMessages.length, 3)
  assert.deepEqual(summarizedMessages[1].tool_calls, [toolCall])
  assert.equal(summarizedMessages[2].tool_call_id, 'call_weather')
  assert.equal(result.messages.length, 4)
  assert.match(String(result.messages[1].content), /^\[Conversation Summary\]/)
  assert.equal(result.summaryGenerated, true)
})

test('sliding window preserves an intact native tool-call exchange', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'old turn' },
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    { role: 'tool', content: 'tool result', tool_call_id: 'call_weather' },
    { role: 'user', content: 'continue from the tool result' },
  ]

  const result = new SlidingWindowStrategy({ enabled: true, maxMessages: 3 }).execute(messages)

  // The window may grow by one message to avoid retaining an orphan tool
  // result. The provider receives the matching assistant tool call too.
  assert.equal(result.messages.length, 4)
  assert.deepEqual(result.messages[1].tool_calls, [toolCall])
  assert.equal(result.messages[2].tool_call_id, 'call_weather')
})

test('summary compression replaces a prior persisted summary instead of accumulating summaries', async () => {
  let summaryInput: ChatMessage[] = []
  const result = await new SummaryStrategy(
    { enabled: true, keepRecentMessages: 1 },
    async (messages) => {
      summaryInput = messages
      return 'new consolidated summary'
    },
  ).execute([
    { role: 'system', content: 'Keep answers factual.' },
    { role: 'system', content: '[Conversation Summary]\nold summary' },
    { role: 'user', content: 'older turn' },
    { role: 'assistant', content: 'older answer' },
    { role: 'user', content: 'latest turn' },
  ])

  assert.equal(summaryInput[0].content, '[Conversation Summary]\nold summary')
  assert.deepEqual(result.messages, [
    { role: 'system', content: 'Keep answers factual.' },
    { role: 'system', content: '[Conversation Summary]\nnew consolidated summary' },
    { role: 'user', content: 'latest turn' },
  ])
})

test('stateful session helpers merge full history and restore streamed tool calls', () => {
  const history: ChatMessage[] = [
    { role: 'system', content: 'be concise' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]
  const fullHistory = [...history, { role: 'user' as const, content: 'new question' }]
  const suffix = [history[2], { role: 'user' as const, content: 'new question' }]

  assert.deepEqual(mergeSessionMessages(history, fullHistory), fullHistory)
  assert.deepEqual(mergeSessionMessages(history, suffix), fullHistory)

  const streamed = assistantMessageFromSSE(
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_","arguments":"{\\"city\\":"}}]}}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"weather","arguments":"\\"Shanghai\\"}"}}]}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'),
  )

  assert.deepEqual(streamed, {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"city":"Shanghai"}',
        },
      },
    ],
  })
})
