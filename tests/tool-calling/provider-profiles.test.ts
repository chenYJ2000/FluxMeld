import test from 'node:test'
import assert from 'node:assert/strict'
import { getProviderToolProfile } from '../../src/main/proxy/toolCalling/providerProfiles.ts'

const calls = [{ id: 'call_1', name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' }]

test('first-version providers use managed prompt and managed xml by default', () => {
  for (const providerId of ['deepseek', 'kimi', 'glm', 'qwen']) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(profile.managedSupport, true)
    assert.equal(profile.supportsNativeTools, false)
    assert.equal(profile.preferredManagedProtocol, 'managed_xml')
  }
})

test('priority providers format tool history with the FluxMeld XML protocol', () => {
  for (const providerId of ['deepseek', 'kimi', 'glm', 'qwen']) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(
      profile.formatAssistantToolCalls(calls),
      '<|FLUXMELD|tool_calls><|FLUXMELD|invoke name="default_api:read_file"><|FLUXMELD|parameter name="filePath"><![CDATA[/tmp/a]]></|FLUXMELD|parameter></|FLUXMELD|invoke></|FLUXMELD|tool_calls>',
    )
    assert.equal(
      profile.formatToolResult({ toolCallId: 'call_1', content: 'file body' }),
      '<|FLUXMELD|tool_result tool_call_id="call_1"><![CDATA[file body]]></|FLUXMELD|tool_result>',
    )
  }
})
