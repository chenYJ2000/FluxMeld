# FluxMeld API 文档

本目录描述 FluxMeld 对外暴露的全部 HTTP 接口。FluxMeld 在 headless（Web）模式下运行两个 HTTP 服务，并额外提供一个浏览器内部桥。

```
┌──────────────────────────────────────────────────────────────────────┐
│                          浏览器 / 外部程序                             │
└───────────────┬───────────────────────────────────────┬──────────────┘
                │                                       │
      :3000 (WEB_PORT)                        :8080 (config.proxyPort)
┌───────────────▼───────────────────────┐   ┌───────────▼───────────────┐
│ Web 服务器 (src/server/webServer.ts)   │   │ 代理服务器 (ProxyServer)   │
│  • React SPA 静态资源                  │   │  • /v1/*  OpenAI 兼容 API  │
│  • /api/invoke + /api/events 内部桥    │──▶│  • /health /stats /        │
│  • /v0/management/* Management API     │反代│                           │
│  • /v1 /health /stats 反向代理到 8080  │   │                           │
└───────────────────────────────────────┘   └───────────────────────────┘
```

- **Management API 只在 3000 提供**（`/v0/management/*`）。
- **8080 只提供 OpenAI 兼容接口**（`/v1/*`）与公开的 `/`、`/health`、`/stats`。
- 3000 也会把 `/v1`、`/health`、`/stats` 反向代理到 8080，因此可以只暴露 3000 一个端口。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [management-api.md](./management-api.md) | 配置、供应商、账号（含批量/查询）、API Key、模型映射、会话、统计、代理控制、Tool Calling |
| [openai-api.md](./openai-api.md) | `/v1/models`、`/v1/chat/completions`、`/v1/completions`、`/health`、`/stats` |
| [web-bridge.md](./web-bridge.md) | `POST /api/invoke`、`GET /api/events`（SSE）、静态资源注入 |
| [appendix.md](./appendix.md) | 数据模型、错误码表、环境变量 |

## 启动与端口

```bash
# 构建并启动（默认监听 0.0.0.0:3000）
npm run web:build
npm run web:start
# 或一步完成
npm run web:dev
```

| 服务 | 默认地址 | 说明 |
| --- | --- | --- |
| Web / Management | `http://0.0.0.0:3000` | 由 `WEB_HOST` / `WEB_PORT` 控制 |
| OpenAI 代理 | `http://0.0.0.0:8080` | 由配置项 `proxyHost` / `proxyPort` 控制（Web 模式下会自动把 `127.0.0.1` 改成 `0.0.0.0`） |

> 桌面（Electron）模式仍可用 `npm run dev` / `npm run build`，但**桌面端不再提供 Management API**，仅在 Web 模式下开放。

## 鉴权

### 1. Web 访问口令（可选）

当设置了环境变量 `WEB_ACCESS_PASSWORD` 时，**3000 上的所有请求**（页面、Management API、`/v1`、`/api/*`）都需要通过以下任一方式携带口令：

| 方式 | 示例 |
| --- | --- |
| 请求头 | `x-access-password: <PASSWORD>` |
| Bearer | `Authorization: Bearer <PASSWORD>` |
| 查询串 | `?access=<PASSWORD>`（并会写入 `fluxmeld_access` Cookie） |
| Cookie | `fluxmeld_access=<PASSWORD>` |

未设置 `WEB_ACCESS_PASSWORD` 时，3000 上的一切接口**无需鉴权**。

### 2. Management API 鉴权

Management API 的鉴权跟随 Web 访问口令：

- 设了 `WEB_ACCESS_PASSWORD`：Management API 需要同样的口令（`Authorization: Bearer` 或 `x-access-password`）。
- 未设：Management API 免鉴权。

> 桌面模式下 Management API 使用配置里的 `managementApi.managementApiSecret`，但该模式已不再挂载 Management API，详见 `management-api.md`。

### 3. `/v1` 代理鉴权（可选 API Key）

代理对 `/v1/*` 提供可选的 API Key 校验，仅当配置项 `enableApiKey = true` 且 `apiKeys` 非空时生效：

| 方式 | 示例 |
| --- | --- |
| Bearer | `Authorization: Bearer sk-mgmt-...` |
| 查询串 | `?api_key=sk-mgmt-...` |
| 请求头 | `X-API-Key: sk-mgmt-...` |

`/`、`/health`、`/stats` 始终公开，不受 API Key 限制。

## 通用约定

### Management API 响应包络

成功：

```json
{ "success": true, "data": { } }
```

失败：

```json
{ "success": false, "error": { "code": "invalid_request", "message": "...", "details": { } } }
```

- `details` 为可选字段。
- 常见 HTTP 状态码：`400` 参数错误、`401` 未鉴权、`404` 资源不存在、`409` 冲突、`500` 服务端错误。

### OpenAI 兼容 API 错误格式

```json
{ "error": { "message": "...", "type": "invalid_request_error", "param": "model", "code": "..." } }
```

### 凭证打码

所有返回账号对象的接口默认把 `credentials` 的每个值替换为 `***`。仅 `POST /v0/management/accounts/query` 在显式传入 `includeCredentials: true` 时返回真实凭证。

### 时间与 ID

- 时间戳统一为**毫秒**（`createdAt`、`updatedAt`、`lastUsed` 等）。
- 账号 ID 由服务端生成，形如 `1789378989603-h8yjq37io`。

### 内容类型

请求体统一使用 `Content-Type: application/json`。
