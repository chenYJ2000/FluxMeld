import test from 'node:test'
import assert from 'node:assert/strict'
import { createProviderForwarders } from '../../src/main/proxy/forwarders/index.ts'
import { shouldMarkAccountFailed, shouldRouteThroughProxy } from '../../src/main/proxy/forwarder.ts'
import type { Provider } from '../../src/main/store/types.ts'

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: '',
    name: '',
    type: 'custom',
    authType: 'token',
    apiEndpoint: '',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function createRegistry() {
  return createProviderForwarders({
    transformRequestForPromptToolUse: () => ({ messages: [], tools: undefined, plan: {} }) as never,
    applyToolCallsToResponse: () => {},
    createBufferedResponseStream: () => ({}) as never,
    extractHeaders: () => ({}),
    shouldDeleteSession: () => false,
  })
}

const EXPECTED_PROVIDERS = [
  'deepseek',
  'glm',
  'kimi',
  'kimi-ai',
  'qwen',
  'qwen-ai',
  'zai',
  'minimax',
  'mimo',
  'perplexity',
]

test('forwarder registry registers every dedicated provider exactly once', () => {
  const names = createRegistry().map((forwarder) => forwarder.name)
  assert.deepEqual(names, EXPECTED_PROVIDERS)
  assert.equal(new Set(names).size, names.length)
})

test('each forwarder matches its own provider id and not a generic custom provider', () => {
  const registry = createRegistry()

  for (const id of EXPECTED_PROVIDERS) {
    const candidate = provider({ id, name: id, apiEndpoint: `https://${id}.example.com` })
    const matched = registry.filter((forwarder) => forwarder.matches(candidate)).map((f) => f.name)
    assert.deepEqual(matched, [id], `provider ${id} matched ${matched.join(',')}`)
  }

  const custom = provider({
    id: 'custom',
    name: 'My Custom',
    apiEndpoint: 'https://api.openai.com',
  })
  assert.deepEqual(
    registry.filter((forwarder) => forwarder.matches(custom)),
    [],
  )
})

test('only retryable provider failures penalize an account', () => {
  assert.equal(shouldMarkAccountFailed(undefined), true)
  assert.equal(shouldMarkAccountFailed(401), true)
  assert.equal(shouldMarkAccountFailed(403), true)
  assert.equal(shouldMarkAccountFailed(429), true)
  assert.equal(shouldMarkAccountFailed(500), true)
  assert.equal(shouldMarkAccountFailed(502), true)

  assert.equal(shouldMarkAccountFailed(400), false)
  assert.equal(shouldMarkAccountFailed(404), false)

  assert.equal(
    shouldMarkAccountFailed(502, undefined, {
      code: 'upstream_multiplexed_response',
      repairable: false,
    }),
    false,
  )
  assert.equal(
    shouldMarkAccountFailed(502, undefined, {
      code: 'upstream_incomplete_response',
      repairable: true,
    }),
    false,
  )
})

test('transport/rate-limit failures route the retry through the outbound proxy', () => {
  assert.equal(shouldRouteThroughProxy(undefined), true)
  assert.equal(shouldRouteThroughProxy(403), true)
  assert.equal(shouldRouteThroughProxy(429), true)
  assert.equal(shouldRouteThroughProxy(503), true)

  assert.equal(shouldRouteThroughProxy(401), false)
  assert.equal(shouldRouteThroughProxy(400), false)
  assert.equal(shouldRouteThroughProxy(404), false)
})
