import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { credentialsEqual, matchesAccountQuery } from '../../src/shared/accountBatch.ts'

test('credentialsEqual compares all credential key/value pairs', () => {
  assert.equal(credentialsEqual({ token: 'a' }, { token: 'a' }), true)
  assert.equal(credentialsEqual({ token: 'a' }, { token: 'b' }), false)
  assert.equal(credentialsEqual({ token: 'a' }, { token: 'a', extra: 'x' }), false)
  assert.equal(credentialsEqual({}, {}), true)
  assert.equal(credentialsEqual(undefined, undefined), true)
  assert.equal(credentialsEqual({ token: 'a' }, undefined), false)
})

test('matchesAccountQuery applies all provided filters with AND semantics', () => {
  const account = {
    id: 'acc-1',
    providerId: 'deepseek',
    name: 'Team Alpha',
    email: 'Alpha@Example.com',
    status: 'active',
    credentials: {},
  } as any

  assert.equal(matchesAccountQuery(account, {}), true)
  assert.equal(matchesAccountQuery(account, { ids: ['acc-1'] }), true)
  assert.equal(matchesAccountQuery(account, { ids: ['other'] }), false)
  assert.equal(matchesAccountQuery(account, { providerId: 'deepseek' }), true)
  assert.equal(matchesAccountQuery(account, { providerId: 'glm' }), false)
  assert.equal(matchesAccountQuery(account, { status: 'active' }), true)
  assert.equal(matchesAccountQuery(account, { status: 'error' }), false)
  assert.equal(matchesAccountQuery(account, { name: 'alpha' }), true)
  assert.equal(matchesAccountQuery(account, { name: 'beta' }), false)
  assert.equal(matchesAccountQuery(account, { email: 'example.com' }), true)
  assert.equal(matchesAccountQuery(account, { name: 'alpha', providerId: 'glm' }), false)
})

test('account management routes expose batch and query endpoints behind management auth', () => {
  const source = readFileSync('src/main/proxy/routes/management/accounts.ts', 'utf8')

  assert.match(source, /router\.post\('\/accounts\/batch', managementAuthMiddleware/)
  assert.match(source, /router\.post\('\/accounts\/batch\/update', managementAuthMiddleware/)
  assert.match(source, /router\.post\('\/accounts\/batch\/delete', managementAuthMiddleware/)
  assert.match(source, /router\.post\('\/accounts\/query', managementAuthMiddleware/)
  assert.match(source, /duplicate_account/)
  assert.match(source, /provider_not_found/)
})

test('proxy server no longer mounts the management API', () => {
  const source = readFileSync('src/main/proxy/server.ts', 'utf8')

  assert.doesNotMatch(source, /managementRoutes/)
  assert.doesNotMatch(source, /\/v0\/management/)
})

test('web server hosts management routes and only proxies OpenAI paths', () => {
  const source = readFileSync('src/server/webServer.ts', 'utf8')

  assert.match(source, /import managementRoutes from '\.\.\/main\/proxy\/routes\/management'/)
  assert.match(source, /const PROXY_PATH_PREFIXES = \['\/v1', '\/health', '\/stats'\]/)
  assert.doesNotMatch(source, /PROXY_PATH_PREFIXES = \[[^\]]*'\/v0'/)
  assert.match(source, /for \(const route of managementRoutes\)/)
})

test('management auth honors the web access password in headless mode', () => {
  const source = readFileSync('src/main/proxy/middleware/managementAuth.ts', 'utf8')

  assert.match(source, /FLUXMELD_MANAGEMENT_ACCESS_PASSWORD/)
  assert.match(source, /FLUXMELD_MANAGEMENT_AUTH_BYPASS/)
  assert.match(source, /X-Access-Password/)
})
