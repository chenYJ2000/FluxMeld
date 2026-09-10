import assert from 'node:assert/strict'
import test from 'node:test'
import { buildKimiAuthHeaders, isKimiOpaqueToken } from '../../src/main/providers/kimiToken'

const JWT_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhcHBfaWQiOiJraW1pIiwidHlwIjoiYWNjZXNzIn0.sig'

test('JWT access tokens are sent via Authorization Bearer', () => {
  assert.equal(isKimiOpaqueToken(JWT_TOKEN), false)
  const headers = buildKimiAuthHeaders(JWT_TOKEN)
  assert.equal(headers.Authorization, `Bearer ${JWT_TOKEN}`)
  assert.equal(headers.Cookie, undefined)
})

test('base64-encoded v10 session tokens are sent via kimi-auth cookie', () => {
  // base64("v10") = "djEw" — the form stored in the kimi-auth cookie
  const opaque = 'djEwXW3UpK' + 'A'.repeat(60)
  assert.equal(isKimiOpaqueToken(opaque), true)
  const headers = buildKimiAuthHeaders(opaque)
  assert.equal(headers.Cookie, `kimi-auth=${opaque}`)
  assert.equal(headers.Authorization, undefined)
})

test('raw v10 session tokens are sent via kimi-auth cookie', () => {
  const raw = 'v10' + String.fromCharCode(0x93, 0x41, 0x7f) + 'padding'
  assert.equal(isKimiOpaqueToken(raw), true)
  const headers = buildKimiAuthHeaders(raw)
  assert.equal(headers.Cookie, `kimi-auth=${raw}`)
})

test('garbage and empty tokens fall back to Bearer', () => {
  assert.equal(isKimiOpaqueToken(''), false)
  assert.equal(isKimiOpaqueToken('not a token'), false)
  const headers = buildKimiAuthHeaders('random-opaque-value')
  assert.equal(headers.Authorization, 'Bearer random-opaque-value')
  assert.equal(headers.Cookie, undefined)
})
