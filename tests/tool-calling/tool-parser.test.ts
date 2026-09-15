import test from 'node:test'
import assert from 'node:assert/strict'
import { managedBracketProtocol } from '../../src/main/proxy/toolCalling/protocols/managedBracket.ts'
import { managedXmlProtocol } from '../../src/main/proxy/toolCalling/protocols/managedXml.ts'
import { anthropicToolUseProtocol } from '../../src/main/proxy/toolCalling/protocols/anthropicToolUse.ts'
import { codexResponsesProtocol } from '../../src/main/proxy/toolCalling/protocols/codexResponses.ts'

const tools = [
  {
    name: 'default_api:read_file',
    description: 'Read a file',
    parameters: { type: 'object' },
    source: 'openai' as const,
  },
]

test('managed bracket parses valid tool call', () => {
  const result = managedBracketProtocol.parse(
    '[function_calls]\n[call:default_api:read_file]{"filePath":"/tmp/a"}[/call]\n[/function_calls]',
    { tools, protocol: 'managed_bracket' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'default_api:read_file')
  assert.equal(result.content, '')
})

test('managed xml parses valid FluxMeld tool call', () => {
  const result = managedXmlProtocol.parse(
    '<|FLUXMELD|tool_calls><|FLUXMELD|invoke name="default_api:read_file"><|FLUXMELD|parameter name="filePath"><![CDATA[/tmp/a]]></|FLUXMELD|parameter></|FLUXMELD|invoke></|FLUXMELD|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'default_api:read_file')
})

test('managed xml parses canonical XML compatibility form', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml accepts single-quoted names and harmless wrapper attributes', () => {
  const result = managedXmlProtocol.parse(
    "<tool_calls version='1'><invoke mode='final' name='default_api:read_file'><parameter required='true' name='filePath'>/tmp/a</parameter></invoke></tool_calls>",
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.arguments, '{"filePath":"/tmp/a"}')
})

test('managed xml preserves and parses a tool call wrapped in a fenced block', () => {
  const result = managedXmlProtocol.parse(
    '```xml\n<|FLUXMELD|tool_calls><|FLUXMELD|invoke name="default_api:read_file"><|FLUXMELD|parameter name="filePath">fake</|FLUXMELD|parameter></|FLUXMELD|invoke></|FLUXMELD|tool_calls>\n```',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.arguments, '{"filePath":"fake"}')
})

test('managed xml parses a direct JSON object inside invoke', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="default_api:read_file">{"filePath":"/tmp/direct"}</invoke></tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.arguments, '{"filePath":"/tmp/direct"}')
})

test('managed xml unwraps an arguments parameter containing the complete JSON object', () => {
  const result = managedXmlProtocol.parse(
    '<|FLUXMELD|tool_calls><|FLUXMELD|invoke name="default_api:read_file"><|FLUXMELD|parameter name="arguments"><![CDATA[{"filePath":"/tmp/wrapped"}]]></|FLUXMELD|parameter></|FLUXMELD|invoke></|FLUXMELD|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.arguments, '{"filePath":"/tmp/wrapped"}')
})

test('managed xml merges explicit parameters with residual direct JSON', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/explicit</parameter>{"encoding":"utf8"}</invoke></tool_calls>',
    {
      tools: [
        {
          ...tools[0],
          parameters: {
            type: 'object',
            properties: { filePath: { type: 'string' }, encoding: { type: 'string' } },
          },
        },
      ],
      protocol: 'managed_xml',
    },
  )

  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    encoding: 'utf8',
    filePath: '/tmp/explicit',
  })
})

test('managed xml marks an empty invoke malformed instead of manufacturing empty arguments', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="default_api:read_file"></invoke></tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 0)
  assert.deepEqual(result.malformedToolNames, ['default_api:read_file'])
  assert.match(result.malformedReason || '', /no parseable JSON arguments/)
})

test('unknown tool name is rejected', () => {
  const result = managedBracketProtocol.parse(
    '[function_calls][call:missing_tool]{"x":1}[/call][/function_calls]',
    { tools, protocol: 'managed_bracket' },
  )

  assert.equal(result.toolCalls.length, 0)
  assert.deepEqual(result.invalidToolNames, ['missing_tool'])
})

test('managed XML parser rejects undeclared tool names and records invalid names', () => {
  const result = managedXmlProtocol.parse(
    '<|FLUXMELD|tool_calls><|FLUXMELD|invoke name="missing_tool">{}</|FLUXMELD|invoke></|FLUXMELD|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 0)
  assert.deepEqual(result.invalidToolNames, ['missing_tool'])
})

test('anthropic adapter parses antml function calls', () => {
  const result = anthropicToolUseProtocol.parse(
    '<antml:function_calls><antml:invoke name="default_api:read_file"><antml:parameters>{"filePath":"/tmp/a"}</antml:parameters></antml:invoke></antml:function_calls>',
    { tools, protocol: 'anthropic_tool_use' },
  )

  assert.equal(result.toolCalls.length, 1)
})

test('codex responses adapter parses response item function call', () => {
  const result = codexResponsesProtocol.parse(
    JSON.stringify({
      type: 'function_call',
      call_id: 'call_1',
      name: 'default_api:read_file',
      arguments: '{"filePath":"/tmp/a"}',
    }),
    { tools, protocol: 'codex_responses' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].id, 'call_1')
})
