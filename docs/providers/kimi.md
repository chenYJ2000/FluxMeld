# Kimi (kimi.com)

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | kimi |
| 官网 | https://www.kimi.com |
| API Base | https://www.kimi.com |
| 认证 | JWT `access_token` + `refresh_token`，或 `kimi-auth` Cookie |
| 凭据字段 | `token`、可选 `refresh_token` |

`kimi-auth` 可能是不透明的 `v10` 会话 Token，也可能是 JWT。`v10` 格式通过 `Cookie: kimi-auth=<token>` 发送，不能走 `Authorization: Bearer`（服务器会报 token malformed）。实际观察到一种情况：浏览器仍保存 `kimi-auth`，但其 JWT `exp` 已过期；重新登录后网站另行写入 Local Storage 的 `access_token`，并未更新旧 Cookie。浏览器显示的 Cookie 过期日期不代表 JWT 仍有效。

优先从 Local Storage 获取 `access_token` 和 `refresh_token`。观察到的访问令牌有效期约为 15 分钟；网站使用 `https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken` 续期，并可能轮换刷新令牌。FluxMeld 保存新令牌，并在到期前、后台检查和认证失败时尝试续期。只有访问令牌或只有旧 Cookie 的账号仍无法自动续期。`www.kimi.ai` 使用单独的供应商和认证方式。

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
2. 打开 DevTools -> Application，清除顶部筛选框，然后选择 Local Storage -> `https://www.kimi.com`。
3. 复制 `access_token` 和 `refresh_token` 的字段值，不要连同键名一起复制或公开令牌。
4. 在供应商管理中添加 Kimi 账号，分别填入访问令牌和可选的刷新令牌并验证。填写刷新令牌后可自动续期。
5. 可选择 `Kimi-K3` 或 `Kimi-K2.6`；调用方可通过 `reasoning_effort` 选择思考强度。

## 批量注册

在「设置 → 批量注册号码 API」配置取号、取码接口后，可在供应商管理中选择 Kimi 批量注册。kimi.com 的手机号登录仅接受中国大陆 `+86` 号码；程序会在官方登录页填写手机号和短信验证码，并在登录成功后验证、保存 `access_token` 与 `refresh_token`。桌面版会打开登录窗口供你完成人机验证。网页版使用独立的无头 Chrome；若出现人机验证而无法取得短信验证码，该号码会失败并释放。开始前需同意 Kimi 的服务条款和隐私政策。
