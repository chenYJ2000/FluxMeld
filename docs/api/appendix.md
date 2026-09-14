# 附录

## 数据模型

### Provider

```ts
interface Provider {
  id: string
  name: string
  type: 'builtin' | 'custom'
  authType: AuthType
  apiEndpoint: string
  chatPath?: string
  headers: Record<string, string>
  enabled: boolean
  createdAt: number          // 毫秒
  updatedAt: number          // 毫秒
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
  status?: 'online' | 'offline' | 'unknown'
  lastStatusCheck?: number
}
```

### Account

```ts
interface Account {
  id: string
  providerId: string
  name: string
  email?: string
  credentials: Record<string, string>  // 默认打码为 "***"
  status: 'active' | 'inactive' | 'expired' | 'error'
  lastUsed?: number
  createdAt: number
  updatedAt: number
  errorMessage?: string
  requestCount?: number
  dailyLimit?: number
  todayUsed?: number
}
```

### ApiKey

```ts
interface ApiKey {
  id: string
  name: string
  key: string                 // 列表/更新返回打码值；创建/重置时完整返回一次
  enabled: boolean
  createdAt: number
  lastUsedAt?: number
  usageCount: number
  description?: string
}
```

### ModelMapping

```ts
interface ModelMapping {
  requestModel: string
  actualModel: string
  preferredProviderId?: string
  preferredAccountId?: string
}
```

### SessionRecord（节选）

```ts
interface SessionRecord {
  id: string
  providerId: string
  accountId: string
  sessionType: 'chat' | 'agent'
  messages: Array<{ role: string; content: unknown; timestamp: number }>
  createdAt: number
  lastActiveAt: number
  status: 'active' | 'expired' | 'deleted'
  model?: string
}
```

### RequestLogEntry（节选）

```ts
interface RequestLogEntry {
  id: string
  timestamp: number
  status: 'success' | 'error'
  model: string
  actualModel?: string
  providerId?: string
  accountId?: string
  latency: number
  isStream: boolean
  errorMessage?: string
}
```

### StatisticsResponse

```ts
interface StatisticsResponse {
  totalRequests: number
  successRequests: number
  failedRequests: number
  avgLatency: number
  requestsPerMinute: number
  activeConnections: number
  modelUsage: Record<string, number>
  providerUsage: Record<string, number>
  accountUsage: Record<string, number>
  dailyStats?: Record<string, { totalRequests: number; successRequests: number; failedRequests: number }>
}
```

### HealthCheckResponse / ProxyStatusResponse

```ts
interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy' | 'degraded'
  version: string
  uptime: number
  timestamp: number
  components?: { proxy: 'up' | 'down'; database: 'up' | 'down'; managementApi: 'up' | 'down' }
}

interface ProxyStatusResponse {
  isRunning: boolean
  port: number
  host: string
  uptime: number
  connections: number
}
```

### 通用响应包络

```ts
interface ManagementApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: { code: string; message: string; details?: Record<string, unknown> }
}
```

## 错误码

### Management API

| code | 状态 | 说明 |
| --- | --- | --- |
| `invalid_request` | 400 | 请求参数缺失/非法 |
| `validation_error` | 400 | 配置校验失败（`details.errors`） |
| `missing_authentication` | 401 | 需要口令未提供 |
| `not_found` | 404 | 供应商不存在 |
| `account_not_found` | 404 | 账号不存在 |
| `api_key_not_found` | 404 | API Key 不存在 |
| `mapping_not_found` | 404 | 模型映射不存在 |
| `session_not_found` | 404 | 会话不存在 |
| `config_key_not_found` | 404 | 配置项不存在 |
| `mapping_exists` | 409 | 模型映射已存在 |
| `duplicate_account` | 200* | 批量新增时凭证重复 |
| `provider_not_found` | — | 批量新增时供应商不存在 |
| `create_failed` | — | 批量新增其它失败 |
| `update_failed` | — | 批量修改失败 |
| `confirmation_required` | 400 | 清空会话缺少 `{ confirm: true }` |
| `already_running` / `not_running` | 400 | 代理启动/停止状态冲突 |
| `forbidden` | 403 | 修改内置供应商 |
| `internal_error` | 500 | 服务端错误 |

\* 批量接口整体返回 `200`，逐条结果在 `results[]` 中标记成功/失败。

### OpenAI API

| code | 状态 | 说明 |
| --- | --- | --- |
| `invalid_request_error` | 400 | 缺少 `model`/`messages`，会话 id 非法 |
| `invalid_api_key` / `missing_api_key` | 401 | API Key 校验失败 |
| `model_not_found` | 404 | 模型不存在 |
| `model_deprecated` | 410 | 模型已废弃 |
| `no_available_account` | 503 | 无可用账号 |
| `api_error` / `internal_error` | 500 | 上游或内部错误 |

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WEB_HOST` | `0.0.0.0` | Web 服务器监听地址 |
| `WEB_PORT` | `3000` | Web 服务器监听端口 |
| `WEB_ACCESS_PASSWORD` | 未设置 | 设置后启用全站访问口令，并作为 Management API 的口令 |
| `FLUXMELD_DATA_DIR` | `~/.fluxmeld` | 数据目录（配置、账号、日志、请求日志）。桌面端与 Web 端可共用同一目录 |
| `FLUXMELD_RENDERER_DIR` | `out/renderer` | 前端静态资源目录 |
| `FLUXMELD_BRIDGE_PATH` | `out/server/__bridge.js` | 前端桥脚本路径 |
| `FLUXMELD_ROOT` | 进程工作目录 | WASM 等资源根目录 |
| `FLUXMELD_MANAGEMENT_AUTH_BYPASS` | Web 模式自动为 `1`（未设口令时） | 为 `1` 时 Management API 免鉴权 |
| `FLUXMELD_MANAGEMENT_ACCESS_PASSWORD` | 由 `WEB_ACCESS_PASSWORD` 派生 | Management API 口令 |
| `FLUXMELD_UPDATE_URL` | 未设置 | 桌面端自动更新源（Web 模式无关） |

> 代理端口 `proxyPort` / 监听地址 `proxyHost` 属于应用配置（`AppConfig`），通过 Management API 的 `/config` 或前端设置页修改。
