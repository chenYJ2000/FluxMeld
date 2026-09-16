# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

FluxMeld Manager is an Electron desktop application that provides an OpenAI-compatible API proxy for multiple AI service providers (DeepSeek, GLM, Kimi, Mimo, MiniMax, Qwen, Qwen AI, Z.ai, Perplexity). It enables using any OpenAI-compatible client with these providers across macOS, Windows, and Linux.

## Build Commands

```bash
# Development
npm run dev              # Start dev server (macOS/Linux)
npm run dev:win          # Start dev server (Windows)

# Build
npm run build            # Build the application
npm run build:mac        # Build for macOS (dmg, zip)
npm run build:win        # Build for Windows (nsis)
npm run build:linux      # Build for Linux (AppImage, deb)
npm run build:all        # Build for all platforms

# Preview production build
npm run preview
```

## Architecture

```
src/
├── main/                    # Electron main process
│   ├── index.ts            # App entry point
│   ├── ipc/                # IPC handlers (main ↔ renderer communication)
│   ├── proxy/              # Proxy server (Koa)
│   │   ├── server.ts       # HTTP server with middleware
│   │   ├── forwarder.ts    # Generic forwarding orchestration
│   │   ├── forwarders/     # Forwarder contracts, shared errors, registry facade
│   │   ├── routes/         # Proxy + management routes
│   │   ├── sessionManager.ts # Multi-turn conversation management
│   │   └── services/       # Prompt injection & prompt generation
│   ├── oauth/              # OAuth authentication framework
│   │   ├── manager.ts      # OAuth flow orchestration
│   │   ├── inAppLogin.ts   # In-app browser login with token auto-extraction
│   │   └── adapters/       # BaseOAuthAdapter + registry facade
│   ├── providers/          # Provider plugin modules (the extension point)
│   │   ├── <id>/           # One self-contained folder per provider
│   │   ├── registry.ts     # Single registration point
│   │   ├── builtin/        # Config-only aggregation for the store
│   │   └── custom.ts       # Custom provider support
│   ├── egress/             # Outbound proxy source plugins (the extension point)
│   │   ├── <id>/           # One self-contained folder per source (clash, config-file)
│   │   ├── registry.ts     # Single registration point
│   │   ├── manager.ts      # EgressManager: allocation + per-request routing
│   │   ├── allocation.ts   # ExitAllocator (cursor + wrap)
│   │   ├── context.ts      # AsyncLocalStorage request-scoped exit
│   │   └── http.ts         # axios per-request proxy injection
│   ├── store/              # Persistent storage (electron-store)
│   │   ├── store.ts        # Main store manager with IPC bridge
│   │   ├── types.ts        # Type definitions and default values
│   │   └── config.ts       # Configuration management
│   └── tray/               # System tray integration
├── preload/                # Context bridge (IPC API exposure)
├── renderer/               # React frontend
│   ├── components/         # UI components
│   ├── pages/              # Page components
│   ├── stores/             # Zustand state management
│   └── i18n/               # Internationalization (en-US, zh-CN)
└── shared/                 # Shared types between main and renderer
```

## Key Concepts

### Provider Modules

Each AI provider is a self-contained plugin under `src/main/providers/<id>/`
(config, adapter, forwarder, oauth, token check, model options, ...) exposed
through a single entry point (`index.ts`). `src/main/providers/registry.ts` is
the one registration point; shared orchestrators dispatch via the registry and
never branch on a provider id.

Multi-provider shared methods live in `src/main/providers/common/` (crypto,
text, `oauthBase`, and the `toolCalling.ts` facade). Provider modules import
from `common/` and may override locally. Stable provider-agnostic
infrastructure stays in `proxy/`; the facade is the provider-facing seam.

A provider declares managed tool-calling support via
`capabilities.toolCalling` on its config; `runtimePlan` and the tool-calling UI
consume that flag.

To add or modify a provider, see `docs/architecture/provider-plugin.md`.

### Egress Sources (Outbound Proxy)

Each way of producing outbound proxy exits is a self-contained plugin under
`src/main/egress/<id>/` (config, source, parser, ...) exposed through an
`index.ts` module. `src/main/egress/registry.ts` is the one registration point;
`EgressManager` allocates exits through the shared `ExitAllocator` and never
branches on a source id.

The effective exit is injected **per request** via `runWithEgress()` (an
async-local context) plus an axios interceptor installed by `egress/http.ts`.
Never mutate `axios.defaults.proxy`. Instances that need it use
`createEgressAxios()`.

Providers may assign accounts to proxy groups via `Provider.proxyAssignment`
(accountId → groupId | null). `null` is the strict-direct group. Groups are
global definitions (`outboundProxy.groups`); each group is bound to an exit
dynamically at runtime. When `outboundProxy.groupAssignmentEnabled` is false all
accounts use the single active exit instead.

Sources expose `probe()` / `listExits()` / `apply(exit)` / `deactivate()`;
`meta.fields` drives the renderer's source settings UI. Shared rotation helpers
live in `src/main/egress/common/`.

To add or modify an egress source, see `docs/architecture/egress-plugin.md`.

### IPC Communication
All main-renderer communication uses IPC channels defined in `src/main/ipc/channels.ts`. The naming convention is `domain:action` (e.g., `proxy:start`, `accounts:add`).

### Session Management
Multi-turn conversations are managed by `sessionManager.ts`:
- `single` mode: Session deleted after each chat
- `multi` mode: Session persists with parent message IDs for context

### Tool Prompt Injection
For models without native function calling, prompts are injected via `promptInjectionService.ts`. This enables function calling compatibility with clients like Cherry Studio and Kilo Code.

### Session Management Flow
1. Client sends request with `sessionId`
2. `sessionManager.ts` retrieves session or creates new one
3. For `multi` mode: parentMessageId is used to fetch conversation history
4. Adapter creates/uses provider-specific session
5. Response is returned with new parentMessageId for context continuation

## Data Storage

Application data is stored in `~/.fluxmeld/`:
- Config, providers, accounts, API keys, sessions: persisted through
  `electron-store` by `src/main/store/store.ts` (single JSON store; account
  credentials are stored as provided credentials).
- `request-logs.ndjson` - Request logs (managed by `src/main/requestLogs/manager.ts`)
- `app-logs.ndjson` - Application logs (managed by `src/main/appLogs/manager.ts`)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Electron 33+ |
| Frontend | React 18 + TypeScript |
| Styling | Tailwind CSS |
| State | Zustand |
| Build | Vite + electron-vite |
| Server | Koa |

## Coding Guidelines

### Immutability (CRITICAL)
ALWAYS create new objects, NEVER mutate existing ones. Use `update` functions that return new copies.

### Error Handling
Handle errors comprehensively:
- Validate all user input before processing
- Provide user-friendly error messages in UI-facing code
- Log detailed error context on the server side
- Never silently swallow errors

### Input Validation
Validate at system boundaries (user input, external APIs). Use schema-based validation where available.

### Security
- Validate all API keys before use
- Sanitize all user inputs
- Never trust external data (API responses, user input, file content)
- Rotate any exposed secrets immediately

## macOS Development Note

A workaround is applied for V8 JIT compiler crash on macOS ARM64 (Electron 33 bug):
```typescript
app.commandLine.appendSwitch('js-flags', '--jitless --no-opt')
```
This trades some performance for stability.

## Adding a New Provider

Provider support is organized around provider modules so adding a provider is an
additive change. See `docs/architecture/provider-plugin.md` for the full guide.

Touch points:

1. `src/main/providers/<id>/` - create the module (`index.ts` + config/adapter/
   forwarder/oauth/tokenCheck/modelOptions as needed).
2. `src/main/providers/registry.ts` - add the module to `providerModules`.
3. `src/main/providers/builtin/index.ts` - append the config to
   `builtinProviders` (config-only aggregation used by the store).
4. `src/shared/types.ts` - add the id to the `ProviderVendor` union.
5. Renderer assets/i18n only: `src/renderer/src/assets/providers/<iconKey>.svg`
   and `src/renderer/src/i18n/locales/{zh-CN,en-US}.json`. Provider capability
   flags and credential-field i18n keys live in the provider's `config.ts`, so
   no renderer component needs a provider-specific branch.

`src/main/store/types.ts` re-exports `builtinProviders` as `BUILTIN_PROVIDERS`,
so the model list has a single source of truth (do not duplicate it).

> `RequestForwarder` in `src/main/proxy/forwarder.ts` must NOT be edited to add a
> provider. It dispatches via `createProviderForwarders()` (registry-backed).

### AuthType Reference

| Type | Credential Field | Providers |
| --- | --- | --- |
| `userToken` | `token` | DeepSeek |
| `jwt` | `token` | Kimi, MiniMax, Qwen AI, Z.ai |
| `refresh_token` | `refresh_token` | GLM |
| `cookie` | `sessionToken` | Perplexity |
| `tongyi_sso_ticket` | `ticket` | Qwen |
| `token` | `token` | Z.ai |

### Web Search / Thinking Mode

Three ways to enable optional modes (see provider adapters): model-name mapping
(e.g. `...search`, `...think`/`r1`), explicit request parameters
(`web_search`, `reasoning_effort`, `enable_thinking`), or request headers
(`X-Enable-Search`, `X-Enable-Thinking`). Thinking content is emitted on the
`reasoning_content` field.

## Updating Provider Configuration

Provider configuration has a **single source of truth**: the provider module's
`config.ts` (e.g. `src/main/providers/zai/config.ts`). `builtin/index.ts`
aggregates those configs and `store/types.ts` re-exports them as
`BUILTIN_PROVIDERS`.

The `initializeDefaultProviders()` method in `store.ts` syncs configuration
(including `capabilities`, `ui` and `credentialFields`) from `BUILTIN_PROVIDERS`
to persistent storage on app startup.

Example: updating the Z.ai model list:
```typescript
// src/main/providers/zai/config.ts
supportedModels: ['GLM-5-Turbo', 'GLM-5', 'GLM-4.7', ...]
```

Do **not** duplicate the model list or config elsewhere.

**Important**: Users must restart the app after configuration updates to see the changes.
