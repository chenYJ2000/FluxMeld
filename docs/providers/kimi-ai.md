# Kimi AI (kimi.ai)

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | kimi-ai |
| 官网 | https://www.kimi.ai |
| API Base | https://www.kimi.ai |
| 认证 | `access_token` JWT + `refresh_token` |
| 凭据字段 | `token`、`refresh_token` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| Kimi-AI-K3 | k3 |
| Kimi-AI-K2.6 | kimi-k2.6 |

## 适配状态

已接入 `www.kimi.ai` 的 Connect JSON 对话接口，并使用 `Authorization: Bearer <access_token>` 发送请求。账号验证使用同站点的 `GET /api/user`。访问令牌接近过期或被拒绝时，使用 `refresh_token` 调用同站点的 `GET /api/auth/token/refresh`，保存轮换后的令牌；刷新令牌失效时需要重新登录。流式、非流式和工具调用使用 Kimi 的共享转换逻辑。

网页服务启动时及此后每 30 分钟检查一次正常账号：访问令牌剩余不足 24 小时，或刷新令牌剩余不足 7 天时，提前续期。请求开始前也会在访问令牌剩余不足 5 分钟时续期；同一刷新令牌的并发请求共用一次续期操作。如果刷新失败但访问令牌尚有效，请求仍可继续使用当前令牌；刷新令牌失效则需要重新登录。网页服务必须保持运行，定时检查才会执行。

实际令牌寿命、模型权限和服务端协议以 Kimi 网站为准。没有真实账号的自动化测试不能代替线上验证。

## 教程

1. 登录 `www.kimi.ai`。
2. 在 Kimi 页面打开 DevTools -> Application -> Local Storage -> `https://www.kimi.ai`。
3. 分别复制 `access_token` 和 `refresh_token` 两行的 Value，不要复制键名，也不要把值发给他人。
4. 在供应商管理中选择 **Kimi AI (kimi.ai)**，将两个值填入对应字段。不要填到 **Kimi (kimi.com)** 账号中。
5. 如果刷新令牌失效，使用账号的“重新登录”入口替换原账号凭据。

## 网页端批量注册

在“设置 → 批量注册号码 API”中启用并配置取号、取短信接口，然后在 Kimi AI 供应商的“批量注册”中填写号码接口对应的国际区号（例如 `+1` 或 `+852`）和数量。阅读并同意 Kimi 服务条款后启动。网页服务会逐个打开独立的无头 Chrome 会话，填写手机号、获取短信验证码、完成登录，并在验证 `access_token` 和 `refresh_token` 后保存账号。手机号只在服务端处理，进度中显示脱敏号码。

需要安装 Google Chrome；此流程当前由 `playwright-core` 驱动。Kimi.ai 不提供中国大陆 `+86` 区号，号码接口须提供站点支持地区的号码。若 Kimi 出现必须由真人完成的人机验证，自动流程会将该账号标记为失败并释放号码，不会保存无效凭据。实际注册需要可用的号码 API、短信接口及 Kimi 官方对自动化的授权；注册页面变化也可能使流程失效。
