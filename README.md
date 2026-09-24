# FluxMeld

<p align="center">
  <img src="build/icons.png" alt="FluxMeld mark" width="112" height="112">
</p>

<p align="center">
  <strong>A local workspace for AI routing</strong><br>
  One desktop control plane for provider accounts, OpenAI-compatible access, and dependable tool calling.
</p>

<p align="center">
  <a href="README_CN.md">简体中文</a> ·
  <a href="LICENSE">GPL-3.0</a> ·
  <a href="NOTICE">Upstream acknowledgement</a>
</p>

> [!NOTE]
> FluxMeld is a locally operated desktop gateway. It gives your AI clients one
> OpenAI-compatible endpoint while you keep control of provider accounts,
> routing, local logs, and runtime settings.

## What FluxMeld is for

FluxMeld is designed for people who work with several model providers but do
not want every editor, agent, and script to manage a different connection.
Run the desktop app, add the accounts you are authorized to use, and connect
clients to one local relay such as http://127.0.0.1:8080/v1.

It focuses on three things:

| Area | What FluxMeld provides |
| --- | --- |
| Local relay | An OpenAI-compatible API endpoint, configurable routing, API keys, request logs, and a desktop status view. |
| Account operations | Provider adapters, account pools, health-aware selection, failover, model mapping, and session handling. |
| Agent reliability | Managed tool calling for supported clients, strict JSON-schema validation, bounded repair, and diagnostics that keep malformed calls out of downstream tools. |

FluxMeld is not a model provider and is not an official API for any listed
provider. Provider web interfaces, model availability, and access policies can
change without notice.

## A workflow built around local control

1. **Connect accounts** — Add the providers and accounts you are permitted to
   use.
2. **Set the relay policy** — Choose an address, port, routing strategy, and
   optional local API-key protection.
3. **Connect your tools** — Point OpenAI-compatible clients to the local
   endpoint.
4. **Observe and improve** — Use the dashboard, logs, account health, model
   mappings, and tool-calling diagnostics to understand what actually ran.

The application stores its own working data under ~/.fluxmeld/ so it does not
reuse or overwrite a predecessor application's data.

## Highlights

- **Provider-account workspace** for DeepSeek, GLM, Kimi (kimi.com), Kimi AI (kimi.ai), MiniMax, MiMo,
  Perplexity, Qwen, Qwen AI, Z.ai, and configured custom providers.
- **OpenAI-compatible relay** for chat completions, model discovery, streaming,
  API-key authentication, and local proxy configuration.
- **Deliberate routing** with model mappings, preferred providers/accounts,
  health checks, retry classification, account quarantine, and failover.
- **Agent-oriented tool calling** with client adapters, OpenCode support,
  declared-tool enforcement, response parsing, JSON-schema validation, and
  bounded repair attempts.
- **Visible local operations** through dashboard telemetry, provider status,
  session controls, and redacted request logs.
- **Desktop-first setup** on macOS, Windows, and Linux with light and dark
  themes.

## Current bundled providers

The table below reflects the defaults shipped with this revision. Provider web
access can change independently of FluxMeld releases.

| Provider | Current default models or status |
| --- | --- |
| DeepSeek | deepseek-v4-flash, deepseek-v4-pro |
| GLM | GLM-5.3, GLM-5.3-Flash |
| Kimi | Kimi-K3, Kimi-K2.6 |
| Kimi AI (kimi.ai) | Kimi-AI-K3, Kimi-AI-K2.6 |
| MiniMax | MiniMax-M2.7 |
| Mimo | MiMo-V2.5-Pro, MiMo-V2.5, MiMo-V2-Flash |
| Perplexity | Auto |
| Qwen | Qwen3.6, Qwen3.7-Max, Qwen3.5-Flash, Qwen3-Max, Qwen3-Max-Thinking-Preview, Qwen3-Coder |
| Qwen AI | Qwen3.7-Max, Qwen3.6-Plus, Qwen3.6-35B-A3B, Qwen3.6-27B, Qwen3-Coder |
| Z.ai | Temporarily unavailable due to frontend captcha risk control |

See [docs/providers](docs/providers/README.md) for adapter notes and provider
specific guidance.

## Quick start

### Requirements

- Node.js 18 or newer
- npm
- Git

### Run from source

~~~bash
git clone <your-FluxMeld-repository-url>
cd FluxMeld
npm install
npm run dev
~~~

### Build a desktop app

~~~bash
npm run build
npm run build:mac
npm run build:win
npm run build:linux
~~~

### Connect a client

1. Launch FluxMeld and add at least one available provider account.
2. Start the local relay from the dashboard or Proxy Settings.
3. Configure an OpenAI-compatible client with:

~~~text
Base URL: http://127.0.0.1:8080/v1
API key:  a FluxMeld API key when API-key protection is enabled
~~~

4. Confirm available models:

~~~bash
curl http://127.0.0.1:8080/v1/models
~~~

If API-key protection is enabled, supply the Authorization header required by
your FluxMeld configuration.

### Optional persistent context

Chat completions remain stateless by default. To let FluxMeld persist a local
conversation, send a client-chosen `session_id` in the request body or an
`X-FluxMeld-Session-Id` request header. FluxMeld echoes the identifier in the
response header, restores its saved context on the next turn, and stores the
latest assistant response (including native tool calls) locally. For the most
predictable behavior after summary compression, send only newly added messages
with the same session ID.

~~~json
{
  "model": "your-model",
  "session_id": "project-chat-2026-08-04",
  "messages": [{ "role": "user", "content": "Continue from the last answer." }]
}
~~~

## Repository guide

| Path | Purpose |
| --- | --- |
| src/main | Electron main process, local proxy, provider adapters, storage, and IPC. |
| src/renderer | React desktop interface, dashboard, settings, provider, model, and log pages. |
| src/shared | Types shared by the Electron processes. |
| docs/providers | Provider-specific notes and setup references. |
| tests | Regression coverage for routing, streaming, tool calling, storage, and UI contracts. |

Useful development commands:

~~~bash
npm test
npm run build
npm run build:unpack
~~~

## Data, credentials, and logs

FluxMeld is a local application. Its application data lives in
~/.fluxmeld/:

| Item | Purpose |
| --- | --- |
| config.json | Local proxy and application settings. |
| providers.json | Provider configuration and model settings. |
| accounts.json | Locally stored account credentials. |
| logs/ | Request and application logs. |

Treat provider credentials and exported configuration files as sensitive. Do
not commit them, attach them to public issues, or paste unredacted request
logs into chats.

## Project lineage and thanks

### Thank you, Chat2API

FluxMeld is an independently maintained GPL-3.0 derivative of
[xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API). We sincerely thank
the original author **xiaoY233** and every Chat2API contributor for openly
sharing the work that made FluxMeld possible.

The original Git history, copyright notices, and GPL-3.0 obligations are
preserved. FluxMeld-specific work is documented separately so the project
lineage remains clear:

- [NOTICE](NOTICE) — attribution, provenance, and non-affiliation notice.
- [FLUXMELD_CHANGES.md](FLUXMELD_CHANGES.md) — FluxMeld identity changes.
- [FORK_CHANGES.md](FORK_CHANGES.md) — retained technical change history.

FluxMeld is not endorsed by, sponsored by, or affiliated with Chat2API or any
listed AI provider.

## License

FluxMeld is distributed under the [GNU General Public License v3.0](LICENSE).
Any redistributed derivative must retain the license, original notices, and
the corresponding source obligations.

## Contributing

Contributions that make local AI routing safer, clearer, and easier to operate
are welcome. Please open an issue with enough redacted context to reproduce
the behavior, then send focused pull requests with tests when possible.
