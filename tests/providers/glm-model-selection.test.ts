import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import axios from 'axios'

import { glmConfig } from '../../src/main/providers/glm/config.ts'
import { GLMAdapter, GLMStreamHandler } from '../../src/main/providers/glm/adapter.ts'
import type { Account, Provider } from '../../src/main/store/types.ts'

for (const model of ['glm-5.3', 'glm-5.3-flash']) {
  for (const stream of [false, true]) {
    test(`GLM sends ${model} to Qingyan with stream=${stream}`, async (t) => {
      const adapter = new GLMAdapter(
        glmConfig as Provider,
        {
          id: 'glm-model-test',
          credentials: { refresh_token: 'test-refresh-token' },
        } as Account,
      )
      t.mock.method(adapter as any, 'acquireToken', async () => 'test-access-token')

      for (const [effort, mode] of [
        ['none', ''],
        ['high', 'thinking'],
        ['max', 'deep_thinking'],
      ]) {
        const post = t.mock.method(axios, 'post', async (url, payload, config) => {
          assert.equal(url, 'https://chatglm.cn/chatglm/backend-api/assistant/stream')
          assert.equal(payload.meta_data.selected_model, model)
          assert.equal(payload.meta_data.chat_mode, mode)
          assert.equal(payload.meta_data.is_networking, true)
          assert.equal(config.responseType, 'stream')
          return {
            status: 200,
            data: Readable.from(
              [
                `data: ${JSON.stringify({
                  status: 'streaming',
                  conversation_id: 'glm-model-test',
                  parts: [{ content: [{ type: 'text', text: 'OK' }] }],
                })}\n\n`,
                'data: {"status":"finish","conversation_id":"glm-model-test"}\n\n',
              ].map((chunk) => Buffer.from(chunk)),
            ),
          }
        })
        // The original alias must not override the resolved provider model.
        const { response } = await adapter.chatCompletion({
          model: model.toUpperCase(),
          originalModel: 'my-glm-alias',
          messages: [{ role: 'user', content: 'Say OK.' }],
          stream,
          reasoningEffort: effort,
          web_search: true,
        })
        const handler = new GLMStreamHandler(model)
        if (stream) {
          const result = await handler.handleStream(response.data)
          const chunks: string[] = []
          for await (const chunk of result) chunks.push(String(chunk))
          const body = chunks.join('')
          assert.ok(body.includes(`"model":"${model}"`))
          assert.ok(body.includes('"content":"OK"'))
          assert.ok(body.includes('data: [DONE]'))
        } else {
          const result = await handler.handleNonStream(response.data)
          assert.equal(result.model, model)
          assert.equal(result.choices[0].message.content, 'OK')
        }
        assert.equal(post.mock.callCount(), 1)
        post.mock.restore()
      }
    })
  }
}

test('GLM custom assistant IDs retain assistant routing without a selected model', async (t) => {
  const adapter = new GLMAdapter(
    glmConfig as Provider,
    {
      id: 'glm-assistant-test',
      credentials: {},
    } as Account,
  )
  t.mock.method(adapter as any, 'acquireToken', async () => 'test-access-token')
  const assistantId = '65940acff94777010aa6b796'
  t.mock.method(axios, 'post', async (_url, payload) => {
    assert.equal(payload.assistant_id, assistantId)
    assert.equal(Object.hasOwn(payload.meta_data, 'selected_model'), false)
    return { status: 200, data: Readable.from([]) }
  })
  await adapter.chatCompletion({
    model: assistantId,
    messages: [{ role: 'user', content: 'Say OK.' }],
  })
})
