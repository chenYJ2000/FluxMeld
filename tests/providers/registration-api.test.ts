import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractVerificationCode,
  maskPhone,
  generateRegistrationPassword,
  normalizeBody,
  normalizePhone,
} from '../../src/main/oauth/registrationApi.ts'

test('normalizeBody unwraps JSON-quoted plain-text responses', () => {
  assert.equal(normalizeBody('"18209880164"'), '18209880164')
  assert.equal(normalizeBody('"ok"'), 'ok')
  assert.equal(normalizeBody('19337953958'), '19337953958')
  assert.equal(normalizeBody('ERROR:余额不足'), 'ERROR:余额不足')
  assert.equal(normalizeBody('"【智谱】验证码123456"'), '【智谱】验证码123456')
})

test('normalizePhone strips quotes, spaces and hyphens', () => {
  assert.equal(normalizePhone('"18209880164"'), '18209880164')
  assert.equal(normalizePhone(' 193-3795-3958 '), '19337953958')
})

test('extractVerificationCode accepts a plain numeric code', () => {
  assert.equal(extractVerificationCode('123456'), '123456')
  assert.equal(extractVerificationCode(' 1234 '), '1234')
})

test('extractVerificationCode parses SMS content from getMsg', () => {
  assert.equal(extractVerificationCode('[抖音]验证码123456'), '123456')
  assert.equal(extractVerificationCode('"【智谱】验证码123456"'), '123456')
  assert.equal(extractVerificationCode('您的验证码为 654321，请勿泄露'), '654321')
  assert.equal(extractVerificationCode('验证码：1234'), '1234')
  assert.equal(extractVerificationCode('verification code: 987654'), '987654')
})

test('extractVerificationCode returns null when no code is present', () => {
  assert.equal(extractVerificationCode('ok'), null)
  assert.equal(extractVerificationCode(''), null)
})

test('maskPhone keeps the first three and last four digits', () => {
  assert.equal(maskPhone('19337953958'), '193****3958')
  assert.equal(maskPhone('12345'), '*****')
})

test('generateRegistrationPassword produces a strong mixed password', () => {
  const password = generateRegistrationPassword()
  assert.equal(password.length, 16)
  assert.match(password, /[A-Z]/)
  assert.match(password, /[a-z]/)
  assert.match(password, /[0-9]/)
  assert.match(password, /[!@#$%^&*]/)
  assert.notEqual(generateRegistrationPassword(), generateRegistrationPassword())
})
