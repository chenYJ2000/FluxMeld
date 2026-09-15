# Provider Plugin Guide

This guide describes how to add or modify a provider using the provider-module
architecture. The goal: **adding or changing a provider should only touch that
provider's own folder, plus one registry line.**

## Architecture

Every provider is a self-contained module under `src/main/providers/<id>/`:

```
src/main/providers/<id>/
├── index.ts          # ProviderModule — the single entry point
├── config.ts         # static config (endpoint, models, credential fields, capabilities, ui)
├── adapter.ts        # OpenAI <-> provider request/response conversion
├── stream.ts         # optional streaming handler (when separate from adapter)
├── forwarder.ts      # provider forwarding strategy
├── oauth.ts          # token acquisition/validation for manual or OAuth login
├── tokenCheck.ts     # account credential validation
├── modelOptions.ts   # provider-specific request option resolution
├── token.ts          # optional provider-specific token helpers
└── challenge.ts      # optional provider-specific crypto (e.g. DeepSeek WASM)
```

The surrounding `providers/` layout (shared code lives in `common/`):

```
src/main/providers/
├── common/           # multi-provider shared methods (import here, or override locally)
│   ├── crypto.ts      # uuid / md5 / unixTimestamp
│   ├── text.ts        # extractTextContent
│   ├── reasoning.ts   # isReasoningEnabled re-export
│   ├── oauthBase.ts   # BaseOAuthAdapter (token acquire/refresh base)
│   └── toolCalling.ts # provider-facing tool-calling facade (re-exports the proxy engine)
├── registry.ts       # the single registration point
├── types.ts          # ProviderModule contract
├── checker.ts        # generic provider status / token-check orchestration
├── custom.ts         # custom provider support
└── <id>/             # one self-contained folder per provider
```

`src/main/providers/registry.ts` is the single registration point. All shared
orchestrators (proxy forwarder, OAuth manager, provider checker, IPC handlers,
store) consume providers through it and never branch on a provider id:

- `providers/registry.ts` — modules, forwarders, OAuth factories, tool profiles
- `providers/builtin/index.ts` — config-only aggregation (no adapter imports) for the store
- `providers/oauthCredentials.ts` — applies a module's `normalizeOAuthCredentials`
- `proxy/forwarders/index.ts`, `oauth/adapters/index.ts`, `oauth/tokenExtractionConfig.ts` — thin facades over the registry

## Shared code (`providers/common/`)

Multi-provider shared methods live in `providers/common/`. A provider module may
import them, or define its own version locally when its protocol differs.
Providers never reach into `proxy/` directly for shared helpers — they use the
`common/` modules (notably the `common/toolCalling.ts` facade).

Stable, provider-agnostic infrastructure (the tool-calling engine, legacy tool
parsers, `proxy/types.ts`) stays in `proxy/`; the `common/toolCalling.ts` facade
is the seam that exposes it to providers.

### Tool-calling support flag

Whether FluxMeld provides managed (prompt-emulated) tool calling for a provider
is a boolean on the provider config:

```ts
capabilities: { clearChats: true, toolCalling: true }
```

It is consumed by `runtimePlan` (falling back to the shared tool profile when
unset) and by the renderer's tool-calling panel, which derives its provider
matrix from `providers.getBuiltin()` instead of a hard-coded list.


## ProviderModule contract

See `src/main/providers/types.ts`. Key fields:

| Field | Purpose |
| --- | --- |
| `config` | Serializable `BuiltinProviderConfig` (also carries `capabilities` + `ui`) |
| `matches(provider)` | Whether this module owns a provider record |
| `createForwarder(services)` | Required forwarding strategy factory |
| `oauth` | `{ factory, authMethods }` |
| `tokenExtraction` | In-app browser login rules |
| `tokenChecker(provider, account)` | Credential validation |
| `normalizeOAuthCredentials(creds)` | Map OAuth result keys to canonical credential names |
| `capabilities` | `clearChats` / `credits` handlers (flags mirrored in `config.capabilities`) |
| `toolProfile` | Tool-calling profile for models without native function calling |

## Adding a provider

1. Create `src/main/providers/<id>/` with the files you need (start from an
   existing provider, e.g. `deepseek/`).
2. Add the id to the `ProviderVendor` union in `src/shared/types.ts`.
3. Register the module in `src/main/providers/registry.ts` (`providerModules`)
   and append its config to `src/main/providers/builtin/index.ts`
   (`builtinProviders`).
4. Add the icon to `src/renderer/src/assets/providers/<iconKey>.svg` (the
   renderer discovers icons automatically via `providerIcon.ts`).
5. Add i18n strings to `src/renderer/src/i18n/locales/{zh-CN,en-US}.json`
   (referenced from `config.credentialFields[*].labelKey`, etc.).

## Modifying a provider

Change only files inside `src/main/providers/<id>/` (and, when needed, the
provider's asset/i18n data). Because shared orchestrators dispatch through the
registry, no central switch or IPC handler needs to change.

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes (add a forwarder/stream/token test under `tests/providers/`)
- [ ] Provider appears in the UI and an account can be added
- [ ] Streaming and non-streaming chat work
- [ ] Thinking/web-search modes work if supported
- [ ] Multi-turn session deletion and clear-chats work
- [ ] `tests/providers/provider-registry.test.ts` still passes
