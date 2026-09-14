import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { GLMStreamHandler } from '../../src/main/proxy/adapters/glm.ts'

test('GLM non-stream preserves Chinese and emoji across every UTF-8 byte boundary', async () => {
  const expected = '{"客户":"中文测试公司🚢","金额":"1,056.90万元"}'
  const frame = Buffer.from(`data: ${JSON.stringify({
    status: 'finish',
    conversation_id: 'utf8-boundary-test',
    parts: [{ logic_id: 'answer', status: 'finish', content: [{ type: 'text', text: expected }] }],
  })}\n\n`, 'utf8')
  const chunks = Array.from(frame, (byte) => Buffer.from([byte]))
  const response = await new GLMStreamHandler('glm-5.2').handleNonStream(Readable.from(chunks))
  assert.equal(response.choices[0].message.content, expected)
  assert.deepEqual(JSON.parse(response.choices[0].message.content), JSON.parse(expected))
})
