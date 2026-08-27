const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..', '..')

test('RequestForwarder dispatches dedicated providers through a registry', () => {
  const source = readFileSync(join(root, 'src/main/proxy/forwarder.ts'), 'utf8')

  assert.match(source, /providerForwarders/)
  assert.doesNotMatch(source, /if \(\w+Adapter\.is\w+Provider\(provider\)\)/)
  assert.match(source, /providerForwarders\.find/)
})

test('RequestForwarder preserves Qwen generation controls', () => {
  const source = readFileSync(join(root, 'src/main/proxy/forwarder.ts'), 'utf8')

  assert.match(source, /enable_thinking: request\.enable_thinking/)
  assert.match(source, /thinking_budget: request\.thinking_budget/)
  assert.match(source, /reasoning_effort: request\.reasoning_effort/)
  assert.match(source, /max_tokens: request\.max_tokens/)
  assert.match(source, /max_completion_tokens: request\.max_completion_tokens/)
  assert.match(source, /maxTokens: request\.max_tokens/)
  assert.match(source, /maxCompletionTokens: request\.max_completion_tokens/)
})

test('Qwen AI uses the request deadline and preserves the selected history protocol', () => {
  const forwarderSource = readFileSync(join(root, 'src/main/proxy/forwarder.ts'), 'utf8')
  const adapterSource = readFileSync(join(root, 'src/main/proxy/adapters/qwen-ai.ts'), 'utf8')

  assert.match(
    forwarderSource,
    /forwardQwenAi\(request, account, provider, actualModel, startTime, context\)/,
  )
  assert.match(forwarderSource, /toolProtocol: transformed\.plan\.protocol/)
  assert.match(forwarderSource, /timeoutMs: getRemainingTimeout\(/)
  assert.match(forwarderSource, /signal: context\.signal/)
  assert.match(adapterSource, /timeout: requestOptions\.timeoutMs \?\? 1800000/)
  assert.match(adapterSource, /signal: requestOptions\.signal/)
})

test('RequestForwarder preserves terminal HTTP status after retries', () => {
  const source = readFileSync(join(root, 'src/main/proxy/forwarder.ts'), 'utf8')

  assert.match(source, /lastStatus = result\.status/)
  assert.match(source, /status: lastStatus/)
})

test('forwarder only penalizes accounts for retryable provider failures', () => {
  const source = readFileSync(join(root, 'src/main/proxy/forwarder.ts'), 'utf8')
  const routeSource = readFileSync(join(root, 'src/main/proxy/routes/chat.ts'), 'utf8')

  assert.match(source, /function shouldMarkAccountFailed/)
  assert.match(source, /status === 401/)
  assert.match(source, /status === 403/)
  assert.match(source, /status === 429/)
  assert.match(source, /status >= 500/)
  assert.doesNotMatch(source, /status >= 400 && status !== 429/)
  assert.doesNotMatch(routeSource, /result\.status >= 400 && result\.status !== 429/)
})
