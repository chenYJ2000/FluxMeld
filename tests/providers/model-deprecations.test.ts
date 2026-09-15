import test from 'node:test'
import assert from 'node:assert/strict'
import { getModelDeprecation } from '../../src/main/proxy/modelDeprecations.ts'

test('GLM-5.1 deprecation requires an explicit user mapping', () => {
  const deprecation = getModelDeprecation('glm-5.1')

  assert.equal(deprecation?.model, 'GLM-5.1')
  assert.equal(deprecation?.replacement, 'GLM-5.3')
  assert.match(deprecation?.message || '', /not selected automatically/)
  assert.match(deprecation?.message || '', /explicit model mapping/)
})

test('current models do not get a deprecation response', () => {
  assert.equal(getModelDeprecation('GLM-5.3'), undefined)
  assert.equal(getModelDeprecation('GLM-5.3-Flash'), undefined)
})
