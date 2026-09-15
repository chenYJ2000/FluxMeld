import test from 'node:test'
import assert from 'node:assert/strict'
import {
  providerModules,
  getProviderModule,
  getBuiltinProvider,
  getSupportedAuthMethods,
} from '../../src/main/providers/registry.ts'

test('every provider module is registered exactly once with a matching config id', () => {
  const ids = providerModules.map((module) => module.id)
  assert.equal(new Set(ids).size, ids.length, 'provider ids must be unique')

  for (const module of providerModules) {
    assert.equal(module.config.id, module.id, `${module.id}: config id mismatch`)
    assert.equal(getBuiltinProvider(module.id), module.config, `${module.id}: config lookup`)
    assert.equal(getProviderModule(module.id), module, `${module.id}: module lookup`)
  }
})

test('serializable config capabilities mirror module capability handlers', () => {
  for (const module of providerModules) {
    assert.equal(
      Boolean(module.config.capabilities?.clearChats),
      Boolean(module.capabilities?.clearChats),
      `${module.id}: clearChats capability flag`,
    )
    assert.equal(
      Boolean(module.config.capabilities?.credits),
      Boolean(module.capabilities?.credits),
      `${module.id}: credits capability flag`,
    )
  }
})

test('toolCalling capability is declared on the expected providers', () => {
  const ids = providerModules
    .filter((module) => module.config.capabilities?.toolCalling)
    .map((module) => module.id)
    .sort()
  assert.deepEqual(ids, ['deepseek', 'glm', 'kimi', 'mimo', 'qwen'])
})

test('every module exposes UI icon metadata and OAuth auth methods', () => {
  for (const module of providerModules) {
    assert.ok(module.config.ui?.iconKey, `${module.id}: missing ui.iconKey`)
    assert.ok(module.oauth, `${module.id}: missing oauth metadata`)
    assert.deepEqual(
      getSupportedAuthMethods(module.id),
      module.oauth!.authMethods,
      `${module.id}: auth methods`,
    )
  }
})
