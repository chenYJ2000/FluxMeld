import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { getEffectiveRequestTimeout } from '../../src/main/proxy/requestTimeoutPolicy.ts'

const toolRequest = {
  model: 'Qwen3.6-Plus',
  messages: [{ role: 'user' as const, content: 'Read the project.' }],
  tools: [{
    type: 'function' as const,
    function: {
      name: 'read',
      parameters: { type: 'object' },
    },
  }],
}

test('OpenCode tool requests receive a three-minute minimum deadline', () => {
  assert.equal(
    getEffectiveRequestTimeout(toolRequest, 'opencode', 60_000),
    180_000,
  )
})

test('a user-configured timeout above the OpenCode minimum is preserved', () => {
  assert.equal(
    getEffectiveRequestTimeout(toolRequest, 'opencode', 240_000),
    240_000,
  )
})

test('a canonical OpenCode request gets the tool deadline even with the standard profile configured', () => {
  assert.equal(
    getEffectiveRequestTimeout({
      ...toolRequest,
      messages: [{
        role: 'system',
        content: 'You are opencode, an interactive CLI tool that helps users with software engineering tasks.',
      }],
    }, 'standard-openai-tools', 60_000),
    180_000,
  )
})

test('other clients and requests without tools retain the configured deadline', () => {
  assert.equal(
    getEffectiveRequestTimeout(toolRequest, 'standard-openai-tools', 60_000),
    60_000,
  )
  assert.equal(
    getEffectiveRequestTimeout({ ...toolRequest, tools: [] }, 'opencode', 60_000),
    60_000,
  )
})

test('session restoration happens before the route resolves the OpenCode deadline', () => {
  const routeSource = readFileSync(
    new URL('../../src/main/proxy/routes/chat.ts', import.meta.url),
    'utf8',
  )
  const sessionRestoreIndex = routeSource.indexOf('sessionManager.prepareSessionMessages')
  const timeoutResolutionIndex = routeSource.indexOf('const requestTimeoutMs = getEffectiveRequestTimeout')

  assert.ok(sessionRestoreIndex >= 0)
  assert.ok(timeoutResolutionIndex > sessionRestoreIndex)
  assert.match(
    routeSource.slice(timeoutResolutionIndex),
    /getEffectiveRequestTimeout\(\s*forwardRequest,/
  )
})
