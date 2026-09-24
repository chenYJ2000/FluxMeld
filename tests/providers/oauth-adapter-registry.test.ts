import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdapter, getSupportedAuthMethods } from '../../src/main/oauth/adapters/index.ts'
import type { AdapterConfig, ProviderType } from '../../src/main/oauth/types.ts'

const PROVIDER_TYPES: ProviderType[] = [
  'deepseek',
  'glm',
  'kimi',
  'kimi-ai',
  'mimo',
  'minimax',
  'perplexity',
  'qwen',
  'qwen-ai',
  'zai',
]

function config(providerType: ProviderType): AdapterConfig {
  return {
    providerId: `${providerType}-id`,
    providerType,
    authMethods: [],
    callbackPort: 0,
  }
}

test('every supported provider type has an OAuth adapter factory', () => {
  for (const providerType of PROVIDER_TYPES) {
    const adapter = createAdapter(providerType, config(providerType))
    assert.ok(adapter, providerType)
    assert.equal(typeof adapter.getSupportedAuthMethods, 'function', providerType)
  }
})

test('every supported provider type exposes auth methods', () => {
  for (const providerType of PROVIDER_TYPES) {
    const methods = getSupportedAuthMethods(providerType)
    assert.ok(Array.isArray(methods) && methods.length > 0, providerType)
  }
})

test('cookie-capable providers advertise the cookie auth method', () => {
  assert.ok(getSupportedAuthMethods('kimi').includes('cookie'))
  assert.ok(getSupportedAuthMethods('mimo').includes('cookie'))
  assert.ok(getSupportedAuthMethods('perplexity').includes('cookie'))
  assert.ok(getSupportedAuthMethods('qwen').includes('cookie'))
})

test('unsupported provider type throws', () => {
  assert.throws(
    () => createAdapter('nope' as ProviderType, config('deepseek')),
    /Unsupported provider type/,
  )
})
