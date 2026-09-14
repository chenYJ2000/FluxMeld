# Web 桥（内部接口）

Web 桥让 React 前端在浏览器中通过 HTTP + SSE 访问后端，等价于 Electron 下的 IPC。它**主要供 FluxMeld 自身的前端使用**；外部程序请优先使用 [Management API](./management-api.md)。

- **基址**：`http://<host>:3000`
- **鉴权**：受 Web 访问口令保护（未设置口令时免鉴权）。

## `POST /api/invoke`

把一次后端调用（对应一个 IPC channel）转发给主进程逻辑。

请求：

```json
{ "channel": "app:getVersion", "args": [] }
```

成功：

```json
{ "ok": true, "data": "0.1.0" }
```

失败（业务错误以 200 返回，`ok:false`）：

```json
{ "ok": false, "error": { "message": "..." } }
```

| 状态 | 场景 |
| --- | --- |
| 400 | 缺少 `channel` |
| 404 | `channel` 未注册 |
| 401 | 需要 Web 访问口令而未通过 |

> `channel` 命名约定为 `domain:action`（如 `proxy:getStatus`、`accounts:getAll`、`config:update`）。完整频道清单见 `src/main/ipc/channels.ts` 与 `src/main/ipc/handlers.ts`，此处不逐一列举。

示例：

```bash
curl -X POST http://127.0.0.1:3000/api/invoke \
  -H "Content-Type: application/json" \
  -d '{ "channel": "proxy:getStatus", "args": [] }'
```

## `GET /api/events`

Server-Sent Events 长连接，用于接收后端主动推送。

- 连接建立时发送注释 `: connected`。
- 每 25 秒发送心跳 `: ping`。
- 每条消息形如：

```
data: {"channel":"proxy:statusChanged","payload":{ ... }}
```

事件清单：

| channel | payload | 说明 |
| --- | --- | --- |
| `proxy:statusChanged` | `ProxyStatus` | 代理启动/停止 |
| `config:changed` | `AppConfig` | 配置更新 |
| `logs:newLog` | `LogEntry` | 新应用日志 |
| `oauth:progress` | `OAuthProgressEvent` | OAuth 进度 |
| `oauth:callback` | `OAuthResult` | OAuth 回调结果 |
| `store:initError` | `{ message: string \| null }` | 存储初始化错误/恢复 |
| `requestLogs:new` | `RequestLogEntry` | 已声明，当前后端不推送 |

> 桌面专属事件（`app:update*`）在 Web 模式下不会触发。

## `GET /__bridge.js`

前端桥脚本，定义并注入 `window.electronAPI`（用 `fetch` + `EventSource` 实现与 preload 相同的接口）。

## 页面注入

Web 服务器在返回 `index.html` 时会注入：

```html
<script>window.__FLUXMELD_WEB_INFO__ = { "accessPasswordRequired": true | false }</script>
<script src="/__bridge.js"></script>
```

前端据此判断 Web 模式下是否需要显示鉴权提示（见设置页 Management API）。
