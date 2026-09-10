# Kimi

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | kimi |
| 官网 | https://www.kimi.com |
| API Base | https://www.kimi.com |
| 认证 | JWT Token 或 v10 会话 Token（kimi-auth Cookie） |
| 凭据字段 | `token` |

新版 kimi.com 的 `kimi-auth` Cookie 值为 `v10` 开头的不透明会话 Token（base64 形式）。该格式通过 `Cookie: kimi-auth=<token>` 携带发送，不能走 `Authorization: Bearer`（服务器会报 token malformed）。会话过期后需重新登录获取，Kimi 不提供刷新接口。

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| Kimi-K3 | k3 |
| Kimi-K2.6 | kimi-k2.6 |

## 适配状态

已适配：Connect JSON 对话接口、流式对话、非流式对话、多轮会话、账号级批量清理对话记录、联网搜索和 K3 思考强度。

K3 请求使用官网当前的 `SCENARIO_OK_COMPUTER` 场景和 `ok-computer` Agent；K2.6 使用 `SCENARIO_K2D5` 场景。下面是 K3 的 OpenAI 兼容参数映射：

| `reasoning_effort` | Kimi 思考强度 | 官网枚举 |
| --- | --- | --- |
| `none` / `off` / `minimal` / `low` / `standard` / `false` | 标准 | `REASONING_EFFORT_LOW` |
| `medium` / `high` / `advanced` / `enabled` / `true` | 进阶 | `REASONING_EFFORT_HIGH` |
| `xhigh` / `max` / `extreme` | 极致（会员权限允许时） | `REASONING_EFFORT_MAX` |

未传 `reasoning_effort` 时使用官网默认的“进阶”。也兼容 camelCase 的 `reasoningEffort` 和 `enable_thinking` 布尔开关；无效值返回 HTTP 400。

后续验证：批量删除接口的返回格式、K3 百万 Token 上下文的会员权限行为。

## 教程

1. 登录 `www.kimi.com`。
2. 打开 DevTools -> Application -> Cookies，复制 `kimi-auth` 值，或复制可用 JWT/refresh token。
3. 在供应商管理中添加 Kimi 账号，填入 `token`。
4. 可选择 `Kimi-K3` 或 `Kimi-K2.6`；调用方可通过 `reasoning_effort` 选择思考强度。
