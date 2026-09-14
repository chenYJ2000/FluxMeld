# OpenAI 兼容 API

- **基址**：`http://<host>:8080`（代理端口），也可经 Web 端口 `http://<host>:3000` 反向代理访问，路径相同。
- **鉴权**：可选 API Key（见下）。`/`、`/health`、`/stats` 始终公开。
- **错误格式**：OpenAI 风格 `{ "error": { "message", "type", "param?", "code?" } }`。

## 可选 API Key 鉴权

当配置项 `enableApiKey = true` 且 `apiKeys` 非空时，`/v1/*` 校验：

```bash
# Bearer
curl http://127.0.0.1:8080/v1/models -H "Authorization: Bearer sk-mgmt-xxxxxxxx"
# 查询串
curl "http://127.0.0.1:8080/v1/models?api_key=sk-mgmt-xxxxxxxx"
# 请求头
curl http://127.0.0.1:8080/v1/models -H "X-API-Key: sk-mgmt-xxxxxxxx"
```

缺失或无效时返回 `401`，`code` 为 `missing_api_key` / `invalid_api_key`。

---

## `GET /v1/models`

列出**当前可用**的模型（供应商已启用、存在活跃账号、且账号池有余量）。同时包含模型映射中定义的请求模型。

```json
{
  "object": "list",
  "data": [
    { "id": "deepseek-v4-flash", "object": "model", "created": 1789378989, "owned_by": "DeepSeek" },
    { "id": "gpt-4o", "object": "model", "created": 1789378989, "owned_by": "model-mapping" }
  ]
}
```

## `GET /v1/models/:model`

查询单个模型。

- 存在且可用：`200` + `ModelInfo`。
- 无可用账号：`503`，`code: no_available_account`。
- 已废弃：`410`，`code: model_deprecated`，`details` 含 `deprecated_model`、`suggested_replacement`、`requires_explicit_mapping`。
- 未找到：`404`，`code: model_not_found`。

---

## `POST /v1/chat/completions`

OpenAI Chat Completions 兼容接口，支持多轮会话、工具调用、Web 搜索与思考模式。

### 请求体

标准 OpenAI 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | `string` | **必填**，请求模型名（可为映射名） |
| `messages` | `array` | **必填**，`system`/`user`/`assistant`/`tool` 消息；内容支持字符串或多模态数组 |
| `stream` | `boolean` | 是否 SSE 流式返回，默认 `false` |
| `temperature` | `number` | 采样温度 |
| `top_p` | `number` | 核采样 |
| `n` | `number` | 生成数量 |
| `stop` | `string \| string[]` | 停止序列 |
| `max_tokens` | `number` | 最大生成 token |
| `max_completion_tokens` | `number` | 最大总生成 token（含推理） |
| `presence_penalty` | `number` | 存在惩罚 |
| `frequency_penalty` | `number` | 频率惩罚 |
| `logit_bias` | `object` | token 偏置 |
| `user` | `string` | 用户标识 |
| `tools` | `array` | OpenAI 工具定义 |
| `tool_choice` | `string \| object` | 工具选择策略 |

FluxMeld 扩展字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `session_id` / `sessionId` | `string` | **有状态会话扩展**。提供后代理会恢复本地持久化的会话历史再转发本轮（1–128 字符，仅 `A-Za-z0-9._:-`）。该字段不会透传给上游。 |
| `web_search` | `boolean` | 开启联网搜索 |
| `web_search_options` | `object` | 搜索上下文大小 `search_context_size`（`low`/`medium`/`high`）与 `user_location` |
| `reasoning_effort` / `reasoningEffort` | `string \| boolean` | 开启思考模式（如 `low`/`medium`/`high`） |
| `deep_research` | `boolean` | 深度研究模式 |

### 请求头

| 头 | 说明 |
| --- | --- |
| `Authorization` | API Key（若启用） |
| `X-FluxMeld-Session-Id` | 会话 id 的头传递方式；与请求体 `session_id` 同时提供时必须一致，否则 `400` |
| `X-Web-Search: true` | 等价于 `web_search: true` |
| `X-Reasoning-Effort: low\|medium\|high` | 等价于 `reasoning_effort` |
| `X-Deep-Research: true` | 等价于 `deep_research: true` |

### 示例

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{ "role": "user", "content": "你好" }],
    "stream": false,
    "web_search": true,
    "reasoning_effort": "medium",
    "session_id": "demo-session-1"
  }'
```

### 非流式响应

```json
{
  "id": "chatcmpl-xxxxxxxx",
  "object": "chat.completion",
  "created": 1789378989,
  "model": "deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "你好！", "reasoning_content": "可选", "tool_calls": [] },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30 }
}
```

响应头会返回 `X-FluxMeld-Session-Id`，可用于后续轮次。

### 流式响应

`stream: true` 时返回 `text/event-stream`，每个事件为 OpenAI 分片：

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1789378989,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}

data: [DONE]
```

思考模式下推理内容放在 `delta.reasoning_content`，正文放在 `delta.content`。

### 错误

| 状态 | code | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | 缺少 `model` / `messages`，或会话 id 非法/不一致 |
| 410 | `model_deprecated` | 模型已废弃 |
| 503 | `no_available_account` | 没有可用账号 |
| 500 | `api_error` / `internal_error` | 上游或内部错误 |

---

## `POST /v1/completions`（legacy）

文本补全接口，内部会转换为 chat 请求。

```json
{ "model": "deepseek-chat", "prompt": "写一首诗", "max_tokens": 256, "stream": false }
```

必填：`model`、`prompt`。无可用账号返回 `503`。

---

## 公开端点

### `GET /`

```json
{ "name": "FluxMeld Proxy", "version": "1.1.2", "description": "OpenAI API compatible proxy service", "endpoints": ["POST /v1/chat/completions", "GET /v1/models", "GET /v1/models/:model", "POST /v1/completions"] }
```

### `GET /health`

```json
{ "status": "running", "uptime": 12345, "statistics": { "totalRequests": 0, "successRequests": 0, "failedRequests": 0, "activeConnections": 0 } }
```

### `GET /stats`

直接返回运行期统计对象（`totalRequests`、`requestsPerMinute`、`activeConnections` 等）。
