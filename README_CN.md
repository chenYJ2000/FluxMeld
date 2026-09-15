# FluxMeld

<p align="center">
  <img src="build/icons.png" alt="FluxMeld 标识" width="112" height="112">
</p>

<p align="center">
  <strong>面向本地 AI 路由的桌面工作台</strong><br>
  在一个应用中管理服务商账户、OpenAI 兼容接口与可靠的工具调用。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="LICENSE">GPL-3.0</a> ·
  <a href="NOTICE">上游致谢与声明</a>
</p>

> [!NOTE]
> FluxMeld 是本地运行的桌面网关：用一个 OpenAI 兼容地址连接你的 AI 客户端，
> 同时把账户、路由、日志和运行时设置保留在自己手里。

## FluxMeld 要解决什么

当你同时使用多个模型服务商时，编辑器、Agent、脚本往往各自维护一套连接。
FluxMeld 把这些账户接入一个本地中继，例如
http://127.0.0.1:8080/v1，并在桌面端提供统一的配置、状态和诊断界面。

它围绕三件事设计：

| 范围 | FluxMeld 提供的能力 |
| --- | --- |
| 本地中继 | OpenAI 兼容接口、路由策略、API Key、请求日志与实时状态。 |
| 账户运营 | 服务商适配、账户池、健康感知选择、故障转移、模型映射与会话管理。 |
| Agent 可靠性 | 面向支持客户端的托管工具调用、严格 JSON Schema 校验、有界修复与诊断信息。 |

FluxMeld 不是模型服务商，也不是所列服务商的官方 API。服务商网页接口、模型可用性
和访问规则都可能随时变化。

## 以本地控制为中心的工作流

1. **接入账户**：添加你有权使用的服务商和账户。
2. **配置中继**：设置监听地址、端口、路由策略，以及可选的本地 API Key 保护。
3. **连接客户端**：让支持 OpenAI 接口的工具指向本地中继。
4. **观察与优化**：通过仪表盘、日志、账户健康度、模型映射和工具调用诊断了解实际执行情况。

FluxMeld 的数据目录是 ~/.fluxmeld/，不会读取或覆盖旧应用安装产生的数据。

## 主要能力

- **多服务商账户工作台**：支持 DeepSeek、GLM、Kimi、MiniMax、MiMo、Perplexity、
  Qwen、Qwen AI、Z.ai，以及已配置的自定义服务商。
- **OpenAI 兼容中继**：提供 chat completions、模型发现、流式响应、API Key
  鉴权和本地代理配置。
- **明确的路由策略**：支持模型映射、首选服务商/账户、健康检查、重试分类、
  账户隔离与故障转移。
- **面向 Agent 的工具调用**：提供客户端适配、OpenCode 支持、声明工具约束、
  响应解析、JSON Schema 校验和有界修复。
- **可见的本地运营**：通过仪表盘、供应商状态、会话控制与脱敏请求日志进行排障。
- **桌面端优先**：支持 macOS、Windows、Linux，以及浅色和深色主题。

## 当前内置服务商

下表反映当前版本随应用提供的默认模型。服务商网页访问状态可能独立于 FluxMeld
版本变化。

| Provider | 当前默认模型或状态 |
| --- | --- |
| DeepSeek | deepseek-v4-flash, deepseek-v4-pro |
| GLM | GLM-5.3, GLM-5.3-Flash |
| Kimi | Kimi-K3, Kimi-K2.6 |
| MiniMax | MiniMax-M2.7 |
| Mimo | MiMo-V2.5-Pro, MiMo-V2.5, MiMo-V2-Flash |
| Perplexity | Auto |
| Qwen | Qwen3.6, Qwen3.7-Max, Qwen3.5-Flash, Qwen3-Max, Qwen3-Max-Thinking-Preview, Qwen3-Coder |
| Qwen AI | Qwen3.7-Max, Qwen3.6-Plus, Qwen3.6-35B-A3B, Qwen3.6-27B, Qwen3-Coder |
| Z.ai | 受前端验证码风控限制，暂不可用 |

服务商适配细节见 [docs/providers](docs/providers/README.md)。

## 快速开始

### 环境要求

- Node.js 18 或更高版本
- npm
- Git

### 从源码运行

~~~bash
git clone <你的-FluxMeld-仓库地址>
cd FluxMeld
npm install
npm run dev
~~~

### 构建桌面应用

~~~bash
npm run build
npm run build:mac
npm run build:win
npm run build:linux
~~~

### 连接客户端

1. 启动 FluxMeld，添加至少一个可用服务商账户。
2. 在仪表盘或“代理设置”中启动本地中继。
3. 将 OpenAI 兼容客户端配置为：

~~~text
Base URL: http://127.0.0.1:8080/v1
API key:  开启 API Key 保护后填写 FluxMeld 生成的密钥
~~~

4. 查看可用模型：

~~~bash
curl http://127.0.0.1:8080/v1/models
~~~

如果你开启了 API Key 保护，请按 FluxMeld 的配置补充 Authorization 请求头。

### 可选的持久化上下文

Chat Completions 默认仍是无状态的。如需让 FluxMeld 在本地保存一段对话，可在请求体传入自行指定的 `session_id`，或设置 `X-FluxMeld-Session-Id` 请求头。FluxMeld 会在响应头回传该标识；下一轮会恢复已保存的上下文，并保存最新的助手回复（包括原生工具调用）。摘要压缩发生后，为获得最稳定的结果，建议继续使用同一个 session ID 且只传入新增加的消息。

~~~json
{
  "model": "your-model",
  "session_id": "project-chat-2026-08-04",
  "messages": [{ "role": "user", "content": "请继续上一轮的回答。" }]
}
~~~

## 仓库导览

| 路径 | 作用 |
| --- | --- |
| src/main | Electron 主进程、本地代理、服务商适配、存储和 IPC。 |
| src/renderer | React 桌面界面，包括仪表盘、设置、供应商、模型与日志页面。 |
| src/shared | Electron 进程间共享的类型。 |
| docs/providers | 服务商说明和配置参考。 |
| tests | 路由、流式响应、工具调用、存储和 UI 协议的回归测试。 |

常用开发命令：

~~~bash
npm test
npm run build
npm run build:unpack
~~~

## 数据、凭证与日志

FluxMeld 是本地应用，数据保存在 ~/.fluxmeld/：

| 项目 | 用途 |
| --- | --- |
| config.json | 本地代理和应用设置。 |
| providers.json | 服务商配置与模型设置。 |
| accounts.json | 本地存储的账户凭证。 |
| logs/ | 请求日志和应用日志。 |

请将服务商凭证和导出的配置文件视为敏感信息：不要提交到仓库，不要在公开 Issue
中上传，也不要在聊天中粘贴未脱敏的请求日志。

## 项目来源与致谢

### 衷心感谢 Chat2API

FluxMeld 是 [xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API) 的独立维护
GPL-3.0 衍生项目。衷心感谢原作者 **xiaoY233** 以及每一位 Chat2API
贡献者开源分享他们的成果，FluxMeld 才能在此基础上继续演进。

本仓库保留原始 Git 历史、版权声明和 GPL-3.0 义务，并将 FluxMeld 自身的身份变更
与继承的技术变更分开记录：

- [NOTICE](NOTICE)：来源、署名与非关联声明。
- [FLUXMELD_CHANGES.md](FLUXMELD_CHANGES.md)：FluxMeld 的身份变更。
- [FORK_CHANGES.md](FORK_CHANGES.md)：保留的技术变更记录。

FluxMeld 不受 Chat2API 或任何所列 AI 服务商的赞助、认可或控制。

## 开源许可

FluxMeld 使用 [GNU General Public License v3.0](LICENSE) 发布。重新分发衍生版本
时，必须保留许可证、原始版权声明和相应的源码义务。

## 贡献

欢迎帮助 FluxMeld 变得更安全、更清晰、更易于运营。提交问题时请提供足够的脱敏复现
信息；提交 Pull Request 时尽量保持改动聚焦并补充测试。
