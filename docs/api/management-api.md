# Management API

- **基址**：`http://<host>:3000/v0/management`
- **鉴权**：跟随 Web 访问口令（见 [README](./README.md#鉴权)）。下面示例默认无口令；若设了 `WEB_ACCESS_PASSWORD`，请为每个请求追加 `-H "x-access-password: YOUR_PASSWORD"`（或 `-H "Authorization: Bearer YOUR_PASSWORD"`）。
- **响应包络**：`{ "success": true, "data": ... }` 或 `{ "success": false, "error": { "code", "message", "details?" } }`。
- **凭证打码**：账号对象的 `credentials` 默认每个值显示为 `***`。

---

## 配置 Config

前缀：`/v0/management/config`

### `GET /config`

获取完整配置（敏感值打码：`managementApi.managementApiSecret`、`apiKeys[].key` 等）。

```bash
curl http://127.0.0.1:3000/v0/management/config
```

```json
{ "success": true, "data": { "proxyPort": 8080, "proxyHost": "0.0.0.0", "loadBalanceStrategy": "round-robin", "modelMappings": { }, "enableApiKey": false, "apiKeys": [], "managementApi": { "enableManagementApi": false, "managementApiSecret": "***" } } }
```

### `PUT /config`

整体更新配置。服务端会执行校验，非法值返回 `400 validation_error`。

```bash
curl -X PUT http://127.0.0.1:3000/v0/management/config \
  -H "Content-Type: application/json" \
  -d '{ "proxyPort": 8080, "loadBalanceStrategy": "fill-first" }'
```

### `GET /config/:key`

读取单个配置项，`:key` 为 `AppConfig` 的字段名（如 `proxyPort`、`enableApiKey`）。不存在返回 `404 config_key_not_found`。

### `PUT /config/:key`

写入单个配置项。

```bash
curl -X PUT http://127.0.0.1:3000/v0/management/config/enableApiKey \
  -H "Content-Type: application/json" \
  -d '{ "value": true }'
```

请求体必须含 `value` 字段，否则 `400 invalid_request`。

---

## 供应商 Providers

前缀：`/v0/management/providers`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/providers` | 列出全部供应商 |
| GET | `/providers/:id` | 获取单个供应商（404 `not_found`） |
| POST | `/providers` | 新建供应商（201） |
| PUT | `/providers/:id` | 更新供应商（内置供应商返回 403 `forbidden`） |
| DELETE | `/providers/:id` | 删除供应商及其账号 |
| PATCH | `/providers/:id/status` | 启用/禁用 |

### `POST /providers`

```json
{
  "name": "My Provider",
  "type": "custom",
  "authType": "token",
  "apiEndpoint": "https://api.example.com",
  "chatPath": "/v1/chat/completions",
  "headers": { "X-Custom": "value" },
  "description": "可选",
  "supportedModels": ["model-a"],
  "modelMappings": { "model-a": "model-a-id" }
}
```

必填：`name`、`authType`、`apiEndpoint`。成功返回 `201` + `Provider`。

### `PATCH /providers/:id/status`

```json
{ "enabled": true }
```

---

## 账号 Accounts

前缀：`/v0/management/accounts`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/accounts` | 列出全部账号（打码） |
| GET | `/accounts/:id` | 获取单个账号 |
| GET | `/providers/:providerId/accounts` | 按供应商列出账号 |
| POST | `/accounts` | 新建账号（严格，无判重） |
| PUT | `/accounts/:id` | 更新账号 |
| DELETE | `/accounts/:id` | 删除账号 |
| POST | `/accounts/:id/validate` | 校验账号凭证 |
| **POST** | **`/accounts/batch`** | **批量新增（严格，判重）** |
| **POST** | **`/accounts/batch/update`** | **批量修改（按 id）** |
| **POST** | **`/accounts/batch/delete`** | **批量删除（ids 与/或 providerId）** |
| **POST** | **`/accounts/query`** | **查询/过滤** |

### `GET /accounts`

返回 `Account[]`，`credentials` 打码。

### `POST /accounts`

```json
{ "providerId": "deepseek", "name": "账号1", "email": "a@b.c", "credentials": { "token": "..." }, "dailyLimit": 100 }
```

必填：`providerId`、`name`、`credentials`。若供应商不存在但属于内置，会自动创建；自定义供应商不存在时返回 `404 provider_not_found`。成功返回 `201` + `Account`。

### `PUT /accounts/:id`

```json
{ "name": "新名称", "email": "x@y.z", "credentials": { "token": "..." }, "dailyLimit": 100 }
```

字段均可选；账号不存在返回 `404 account_not_found`。

### `DELETE /accounts/:id`

返回 `{ "success": true, "data": { "id": "...", "deleted": true } }`。

### `POST /accounts/:id/validate`

返回 `ValidationResult`：

```json
{ "valid": true, "validatedAt": 1789378989603, "accountInfo": { "email": "a@b.c" } }
```

校验通过会把账号状态置为 `active`，失败置为 `error` 并写入 `errorMessage`。

### `POST /accounts/batch` — 批量新增（严格）

按 `providerId + credentials` 判重：同一供应商下若存在**凭证完全相同**的账号，该项失败（`duplicate_account`），不更新。

```bash
curl -X POST http://127.0.0.1:3000/v0/management/accounts/batch \
  -H "Content-Type: application/json" \
  -d '{
    "accounts": [
      { "providerId": "deepseek", "name": "a1", "credentials": { "token": "tok-1" } },
      { "providerId": "deepseek", "name": "a2", "credentials": { "token": "tok-2" } }
    ]
  }'
```

响应（部分成功不整批失败）：

```json
{
  "success": true,
  "data": {
    "total": 2,
    "succeeded": 1,
    "failed": 1,
    "results": [
      { "index": 0, "success": true, "account": { "id": "1789...-abc", "credentials": { "token": "***" } } },
      { "index": 1, "success": false, "error": { "code": "duplicate_account", "message": "Account with identical credentials already exists: 1789...-xyz" } }
    ]
  }
}
```

逐项错误码：`duplicate_account`、`provider_not_found`、`create_failed`（缺少必填字段等）。

### `POST /accounts/batch/update` — 批量修改（按 id）

```json
{
  "updates": [
    { "id": "1789...-abc", "name": "renamed" },
    { "id": "does-not-exist", "dailyLimit": 10 }
  ]
}
```

可更新字段：`name`、`email`、`credentials`、`dailyLimit`、`status`（`active` / `inactive` / `expired` / `error`）。

响应同批量结构，`success:false` 时带 `id` 与 `error`（如 `account_not_found`、`update_failed`）。

### `POST /accounts/batch/delete` — 批量删除

至少提供 `ids` 或 `providerId` 之一，否则 `400 invalid_request`。

```json
{ "ids": ["1789...-abc"], "providerId": "deepseek" }
```

- `ids`：删除指定账号。
- `providerId`：删除该供应商下**全部**账号（会与 `ids` 合并去重）。

响应在通用批量结构上额外带 `deletedCount`：

```json
{
  "success": true,
  "data": {
    "total": 2,
    "succeeded": 1,
    "failed": 1,
    "deletedCount": 1,
    "results": [
      { "index": 0, "success": true, "id": "1789...-abc" },
      { "index": 1, "success": false, "id": "missing", "error": { "code": "account_not_found", "message": "Account not found: missing" } }
    ]
  }
}
```

### `POST /accounts/query` — 查询/过滤

所有条件为 **AND** 关系；`name`、`email` 为**大小写不敏感子串**匹配。

```json
{
  "ids": ["1789...-abc"],
  "providerId": "deepseek",
  "status": "active",
  "name": "a1",
  "email": "example.com",
  "includeCredentials": false
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ids` | `string[]` | 命中其中任一 id |
| `providerId` | `string` | 供应商过滤 |
| `status` | `AccountStatus` | `active` / `inactive` / `expired` / `error` |
| `name` | `string` | 名称子串（忽略大小写） |
| `email` | `string` | 邮箱子串（忽略大小写） |
| `includeCredentials` | `boolean` | `true` 时返回真实凭证，默认 `false`（打码） |

响应：

```json
{ "success": true, "data": { "total": 2, "items": [ { "id": "1789...-abc", "credentials": { "token": "***" } } ] } }
```

---

## API Key

前缀：`/v0/management/api-keys`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api-keys` | 列出全部（`key` 打码为 `sk-mgmt-...{后8位}`） |
| POST | `/api-keys` | 新建（201，`key` 仅此一次完整返回） |
| PUT | `/api-keys/:id` | 更新 `name` / `description` / `enabled` |
| DELETE | `/api-keys/:id` | 删除 |
| POST | `/api-keys/:id/regenerate` | 重新生成 key（完整返回一次，`usageCount` 归零） |

### `POST /api-keys`

```json
{ "name": "production", "description": "可选" }
```

```json
{ "success": true, "data": { "id": "uuid", "name": "production", "key": "sk-mgmt-8f...e1", "enabled": true, "createdAt": 1789378989603, "usageCount": 0 } }
```

> 请立即保存完整 key，之后只能看到打码值。错误码：`api_key_not_found`、`invalid_request`。

---

## 模型映射 Model Mappings

前缀：`/v0/management/model-mappings`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/model-mappings` | 列出全部映射 |
| POST | `/model-mappings` | 新建（201；已存在返回 409 `mapping_exists`） |
| PUT | `/model-mappings/:model` | 更新（`:model` 需 URL 编码） |
| DELETE | `/model-mappings/:model` | 删除 |

```json
{ "requestModel": "gpt-4o", "actualModel": "deepseek-chat", "preferredProviderId": "deepseek", "preferredAccountId": "可选" }
```

必填：`requestModel`、`actualModel`。`PUT` 请求体字段：`actualModel`、`preferredProviderId`、`preferredAccountId`。

---

## 会话 Sessions

前缀：`/v0/management/sessions`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/sessions` | 列出活跃会话（`SessionRecord[]`） |
| GET | `/sessions/:id` | 获取单个会话及其消息历史（404 `session_not_found`） |
| DELETE | `/sessions/:id` | 删除指定会话 |
| DELETE | `/sessions` | 清空全部会话，**必须**提供 `{ "confirm": true }` |

```bash
curl -X DELETE http://127.0.0.1:3000/v0/management/sessions \
  -H "Content-Type: application/json" \
  -d '{ "confirm": true }'
# => { "success": true, "data": { "cleared": true } }
```

缺少确认体返回 `400 confirmation_required`。

---

## 统计 / 健康 / 日志

### `GET /v0/management/statistics`

返回 `StatisticsResponse`：累计请求数、成功率、平均延迟、每分钟请求、活跃连接、按模型/供应商/账号的使用量等。

### `GET /v0/management/health`

```json
{
  "success": true,
  "data": {
    "health": { "status": "healthy", "version": "0.1.0", "uptime": 12345, "timestamp": 1789378989603, "components": { "proxy": "up", "database": "up", "managementApi": "up" } },
    "proxy": { "isRunning": true, "port": 8080, "host": "0.0.0.0", "uptime": 12345, "connections": 0 }
  }
}
```

### `GET /v0/management/logs`

| 查询参数 | 说明 |
| --- | --- |
| `type` | `request`（默认，结构化请求日志）或 `system`（应用日志） |
| `level` | `debug` / `info` / `warn` / `error`（request 类型下 `error` 表示失败请求，`info` 表示成功请求） |
| `page` | 页码，默认 1 |
| `limit` | 每页条数，1–200，默认 50 |

```json
{ "success": true, "data": { "logs": [ ], "pagination": { "page": 1, "limit": 50, "total": 128, "totalPages": 3 } } }
```

---

## 代理控制 Proxy

前缀：`/v0/management/proxy`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/proxy/start` | 启动代理（已在运行返回 400 `already_running`） |
| POST | `/proxy/stop` | 停止代理（未运行返回 400 `not_running`） |
| POST | `/proxy/restart` | 重启 |
| GET | `/proxy/status` | 查询状态 |

启动/重启可选请求体：`{ "port": 8080, "host": "0.0.0.0" }`。成功返回 `{ "isRunning": true, "port": 8080, "host": "0.0.0.0" }`。

> **注意**：这组控制端点操作的是代理模块的独立实例，与应用内（IPC `proxy:start` / 前端按钮）启动的代理**不是同一个实例**。若代理已由应用启动，再调用 `/proxy/start` 会因端口占用失败。日常建议通过前端控制代理；`/proxy/status`、`/statistics`、`/health` 反映的是全局运行状态，不受此限制。

---

## Tool Calling

前缀：`/v0/management/tool-calling`

### `GET /tool-calling/status`

```json
{ "success": true, "data": { "config": { }, "latestSmokeResult": null } }
```

### `POST /tool-calling/smoke`

```json
{ "clientAdapterId": "opencode" }
```

生成一份冒烟夹具：

```json
{ "success": true, "data": { "result": { "success": true, "category": "pass", "clientAdapterId": "opencode", "timestamp": 1789378989603 }, "fixture": { } } }
```
