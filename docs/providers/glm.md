# GLM

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | glm |
| 官网 | https://chatglm.cn |
| API Base | https://chatglm.cn/api |
| 认证 | Refresh Token |
| 凭据字段 | `refresh_token` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| GLM-5.3 | glm-5.3 |
| GLM-5.3-Flash | glm-5.3-flash |

模型 ID 通过 `meta_data.selected_model` 传给清言，与 `chat_mode` 思考强度独立。官网模型菜单将 Flash 显示为 `GLM-Flash`，对应 ID 为 `glm-5.3-flash`。

来源：[清言模型配置](https://chatglm.cn/chatglm/agent-api/operation/detail?tag=available_models)（2026-09-15 核对，需有效登录或访客会话）。

## 适配状态

已适配：流式对话、非流式对话、多轮会话、账号级清理对话记录、刷新 token 校验、联网搜索、思考内容输出和 GLM-5.3 / GLM-5.3-Flash 分级思考。

两个模型在网页端均提供“快速 / 深度 / 极致”三档，OpenAI 兼容参数映射如下：

| `reasoning_effort` | 智谱清言模式 | 官网 `chat_mode` |
| --- | --- | --- |
| `none` / `off` / `minimal` / `fast` / `false` | 快速 | 空字符串 |
| `low` / `medium` / `high` / `standard` / `enabled` / `true` | 深度 | `thinking` |
| `xhigh` / `max` / `deep` | 极致 | `deep_thinking` |

未传 `reasoning_effort` 时保留现有的 `thinking` 默认值（当前官网称为“深度”）。也兼容 camelCase 的 `reasoningEffort` 和 `enable_thinking` 布尔开关；无效值返回 HTTP 400。

后续验证：视频/多模态能力、清理对话记录接口字段变化。

## 教程

1. 登录 `chatglm.cn`。
2. 打开 DevTools -> Application -> Local Storage，复制 `chatglm_refresh_token`。
3. 在供应商管理中添加 GLM 账号，填入 `refresh_token`。
4. 分别使用 `GLM-5.3` 和 `GLM-5.3-Flash` 验证流式和非流式请求，并通过 `reasoning_effort` 选择思考程度。
