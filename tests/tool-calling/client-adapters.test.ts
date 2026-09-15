import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getToolClientAdapter,
  hasOpenCodeSystemIdentity,
  resolveToolClientAdapterForRequest,
} from '../../src/main/proxy/toolCalling/clientAdapters/index.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'weather in Hangzhou?' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'weather-test:get_weather',
          description: 'Get weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ],
    tool_choice: 'auto',
    ...overrides,
  }
}

test('standard OpenAI adapter normalizes OpenAI tools and tool_choice', () => {
  const adapter = getToolClientAdapter('standard-openai-tools')
  const result = adapter.normalizeRequest(request())

  assert.equal(result.clientAdapterId, 'standard-openai-tools')
  assert.equal(result.toolSource, 'openai')
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['weather-test:get_weather'],
  )
  assert.equal(result.toolChoice.mode, 'auto')
})

test('an unambiguous OpenCode system identity selects its compatibility adapter', () => {
  const openCodeRequest = request({
    messages: [
      {
        role: 'system',
        content:
          'You are opencode, an interactive CLI tool that helps users with software engineering tasks.',
      },
      { role: 'user', content: '阅读当前项目。' },
    ],
  })

  const resolved = resolveToolClientAdapterForRequest('standard-openai-tools', openCodeRequest)

  assert.equal(hasOpenCodeSystemIdentity(openCodeRequest.messages), true)
  assert.equal(resolved.adapter.id, 'opencode')
  assert.equal(resolved.resolvedBy, 'request_identity')
  assert.equal(resolved.configuredClientAdapterId, 'standard-openai-tools')
  assert.equal(
    resolveToolClientAdapterForRequest('standard-openai-tools', request()).adapter.id,
    'standard-openai-tools',
  )
  assert.equal(
    resolveToolClientAdapterForRequest('cherry-studio-mcp', openCodeRequest).adapter.id,
    'cherry-studio-mcp',
  )
})

test('standard OpenAI adapter detects an exact refusal for a declared tool', () => {
  const adapter = getToolClientAdapter('standard-openai-tools')
  const allowedTools = new Set(['bash', 'read'])

  assert.deepEqual(adapter.detectToolRefusal?.('Tool bash does not exists.', allowedTools), {
    toolName: 'bash',
  })
  assert.equal(adapter.detectToolRefusal?.('Tool shell does not exist.', allowedTools), undefined)
  assert.equal(
    adapter.detectToolRefusal?.(
      'Tool bash does not exists.\n\nThe requested change has already been completed.',
      allowedTools,
    ),
    undefined,
  )
  assert.equal(
    adapter.stripToolRefusalPreamble?.(
      'Tool bash does not exists.\n\nThe requested change has already been completed.',
      allowedTools,
    ),
    'The requested change has already been completed.',
  )
})

test('Cherry Studio MCP adapter preserves exact MCP tool names', () => {
  const adapter = getToolClientAdapter('cherry-studio-mcp')
  const result = adapter.normalizeRequest(request())

  assert.equal(result.clientAdapterId, 'cherry-studio-mcp')
  assert.equal(result.toolSource, 'mcp')
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['weather-test:get_weather'],
  )
  assert.equal(result.tools[0].name.includes('getWeather'), false)
})

test('OpenCode adapter preserves its OpenAI tool contract while using the provider protocol', () => {
  const adapter = getToolClientAdapter('opencode')
  const result = adapter.normalizeRequest(
    request({
      tools: [
        {
          type: 'function',
          function: {
            name: 'bash',
            description: 'Run a shell command',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'read',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ],
    }),
  )

  assert.equal(result.clientAdapterId, 'opencode')
  assert.equal(result.toolSource, 'openai')
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['bash', 'read'],
  )
  assert.equal(result.preferredProtocol, undefined)
  assert.deepEqual(result.preferredProtocolByProvider, {
    qwen: 'managed_bracket',
    'qwen-ai': 'managed_bracket',
  })
  assert.equal(result.diagnostics.detectedClientType, 'opencode')

  assert.deepEqual(
    adapter.detectToolRefusal?.('Tool bash does not exists.', new Set(['bash', 'read'])),
    { toolName: 'bash' },
  )
  assert.equal(
    adapter.detectToolRefusal?.('Tool shell does not exist.', new Set(['bash', 'read'])),
    undefined,
  )
  assert.deepEqual(
    adapter.detectToolRefusal?.(
      'I cannot run bash commands or use tools as I am designed to provide direct answers.',
      new Set(['bash', 'read']),
    ),
    { toolName: 'bash' },
  )
  assert.equal(
    adapter.detectToolRefusal?.(
      'Tool read does not exists.\n\nProject overview: FluxMeld is an Electron app.',
      new Set(['bash', 'read']),
    ),
    undefined,
  )
  assert.equal(
    adapter.stripToolRefusalPreamble?.(
      'Tool read does not exists.\n\nProject overview: FluxMeld is an Electron app.',
      new Set(['bash', 'read']),
    ),
    'Project overview: FluxMeld is an Electron app.',
  )
  assert.equal(
    adapter.stripToolRefusalPreamble?.(
      'Tool read does not exists.\nTool glob does not exists.\n\nProject overview: FluxMeld is an Electron app.',
      new Set(['bash', 'read']),
    ),
    'Project overview: FluxMeld is an Electron app.',
  )
})

test('OpenCode forces only a tool explicitly requested by the user', () => {
  const adapter = getToolClientAdapter('opencode')
  const result = adapter.normalizeRequest(
    request({
      messages: [{ role: 'user', content: 'Use the `read` tool exactly once, then stop.' }],
      tools: [
        {
          type: 'function',
          function: { name: 'read', parameters: { type: 'object', properties: {} } },
        },
        {
          type: 'function',
          function: { name: 'bash', parameters: { type: 'object', properties: {} } },
        },
      ],
    }),
  )

  assert.equal(result.toolChoice.mode, 'forced')
  assert.equal(result.toolChoice.forcedName, 'read')
})

test('OpenCode narrows read-only project exploration to inspection tools', () => {
  const adapter = getToolClientAdapter('opencode')
  const result = adapter.normalizeRequest(
    request({
      messages: [
        { role: 'user', content: '只读测试：阅读一下我的项目。严禁调用 edit、write 或 bash。' },
      ],
      tools: ['bash', 'read', 'glob', 'grep', 'edit', 'write', 'task'].map((name) => ({
        type: 'function' as const,
        function: { name, parameters: { type: 'object', properties: {} } },
      })),
    }),
  )

  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['read', 'glob', 'grep'],
  )
  assert.equal(result.toolChoice.mode, 'forced')
  assert.equal(result.toolChoice.forcedName, 'glob')
})

test('OpenCode gives code-change tasks only the needed file and shell tools', () => {
  const adapter = getToolClientAdapter('opencode')
  const result = adapter.normalizeRequest(
    request({
      messages: [
        { role: 'user', content: 'Please read this project and fix the timeout handling.' },
      ],
      tools: ['bash', 'read', 'glob', 'grep', 'edit', 'write', 'task', 'webfetch'].map((name) => ({
        type: 'function' as const,
        function: { name, parameters: { type: 'object', properties: {} } },
      })),
    }),
  )

  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['bash', 'read', 'glob', 'grep', 'edit', 'write'],
  )
  assert.equal(result.toolChoice.mode, 'auto')
})

test('OpenCode advances an explicit sequential tool request after its first call', () => {
  const adapter = getToolClientAdapter('opencode')
  const result = adapter.normalizeRequest(
    request({
      messages: [
        { role: 'user', content: 'First use the read tool. Then use the edit tool.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_read',
              type: 'function',
              function: { name: 'read', arguments: '{"filePath":"/tmp/test"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_read', content: 'file content' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'read', parameters: { type: 'object', properties: {} } },
        },
        {
          type: 'function',
          function: { name: 'edit', parameters: { type: 'object', properties: {} } },
        },
      ],
    }),
  )

  assert.equal(result.toolChoice.mode, 'forced')
  assert.equal(result.toolChoice.forcedName, 'edit')
})

test('forced tool choice validates against normalized tools', () => {
  const adapter = getToolClientAdapter('standard-openai-tools')
  const result = adapter.normalizeRequest(
    request({
      tool_choice: { type: 'function', function: { name: 'weather-test:get_weather' } },
    }),
  )

  assert.equal(result.toolChoice.mode, 'forced')
  assert.equal(result.toolChoice.forcedName, 'weather-test:get_weather')
})

test('unknown adapter falls back to standard adapter metadata and records diagnostic hint', () => {
  const adapter = getToolClientAdapter('unknown-client')
  const result = adapter.normalizeRequest(request())

  assert.equal(adapter.id, 'standard-openai-tools')
  assert.equal(result.diagnostics.requestedClientAdapterId, 'unknown-client')
  assert.equal(result.diagnostics.fallbackClientAdapterId, 'standard-openai-tools')
})
