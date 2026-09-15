# Architecture

FluxMeld is an Electron desktop application (with an optional headless web mode)
that exposes an OpenAI-compatible gateway in front of multiple AI providers.

## High-level layout

```
src/
├── main/                 Electron main process
│   ├── index.ts          App entry point
│   ├── ipc/              IPC handlers (main <-> renderer)
│   ├── proxy/            OpenAI-compatible proxy (Koa)
│   │   ├── server.ts     HTTP server + middleware
│   │   ├── forwarder.ts  Generic retry/failover orchestration
│   │   ├── forwarders/   Per-provider forwarder plugins
│   │   ├── adapters/     Per-provider request/stream adapters
│   │   ├── routes/       Proxy + management routes
│   │   ├── services/     Context management, prompt generation
│   │   └── toolCalling/  Prompt-based tool-calling engine
│   ├── oauth/            OAuth/manual token authentication
│   ├── providers/        Provider configs + built-in registry
│   ├── store/            Persistence (electron-store)
│   ├── appLogs/          App log persistence
│   ├── requestLogs/      Request log persistence
│   ├── tray/ window/ updater/
│   └── lib/              Small cross-cutting utilities (e.g. app lifecycle)
├── preload/              Context bridge
├── renderer/             React UI
├── server/               Headless Node server (electron aliased to stubs)
├── web/                  Browser bridge for headless mode
└── shared/               Types shared by main + renderer
```

## Core abstractions

### Provider forwarder registry (open/closed seam)

`src/main/proxy/forwarder.ts` is the generic orchestrator: it performs account
selection, retry/failover, outbound-proxy rotation, context management, and
tool-repair, then dispatches to a provider-specific forwarder.

Each provider implements `ProviderForwarder` (see
`src/main/proxy/forwarders/types.ts`) in its own module and registers in
`src/main/proxy/forwarders/index.ts`:

- `deepseek.ts`, `glm.ts`, `kimi.ts`, `qwen.ts`, `qwen-ai.ts`, `zai.ts`,
  `minimax.ts`, `mimo.ts`, `perplexity.ts`

Provider forwarders only depend on the injected `ForwarderServices` interface
(transform, apply tool calls, buffered stream, headers, session policy), not on
the `RequestForwarder` class. **Adding a provider therefore requires no edits to
`forwarder.ts`.**

### Provider adapters

`src/main/proxy/adapters/<provider>.ts` converts OpenAI-format requests into the
provider's web API and parses responses (streaming and non-streaming). Stream
handlers convert provider events back into OpenAI `chat.completion.chunk`
streams and translate managed tool calls.

### OAuth adapters

`src/main/oauth/adapters/index.ts` maps each provider to an adapter factory via a
registry map instead of a switch statement.

### Persistence

`src/main/store/store.ts` is the `StoreManager` singleton. Domain types live in
`src/shared/types.ts` and are re-exported by `src/main/store/types.ts` so main and
renderer share a single definition.

### Headless mode

`src/server/` runs the app in plain Node by aliasing `electron`,
`electron-store`, and `electron-updater` to stubs (`src/server/stubs/`). The
browser bridge (`src/web/bridge.ts`) exposes `window.electronAPI` so the same
renderer runs in a browser.

## Quality gates

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` for main, renderer, and server/web |
| `npm run lint` | ESLint (flat config) |
| `npm run format` / `format:check` | Prettier |
| `npm test` | Node built-in test runner via `scripts/run-tests.mjs` |
| `npm run test:coverage` | Tests with Node's experimental coverage |
| `npm run build` | `check:source-artifacts` + `electron-vite build` |

CI runs typecheck, lint, tests, and build (`.github/workflows/ci.yml`).
