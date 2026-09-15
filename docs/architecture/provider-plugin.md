# Provider Plugin Guide

This guide describes how to add or modify a provider using the open/closed
registry architecture. The goal: **extending the app should mean adding files
and registry entries, not editing shared orchestration code.**

## Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| Config | `src/main/providers/builtin/<provider>.ts` | Static provider config (endpoint, headers, models, credential fields) |
| OAuth | `src/main/oauth/adapters/<provider>.ts` | Token acquisition/validation for manual or OAuth login |
| Proxy adapter | `src/main/proxy/adapters/<provider>.ts` | OpenAI → provider request/response conversion |
| Forwarder | `src/main/proxy/forwarders/<provider>.ts` | Provider-specific forwarding strategy |
| UI | `src/renderer/...`, `src/assets/providers/<provider>.svg` | Icon + i18n strings |

## Steps

### 1. Provider config

Create `src/main/providers/builtin/<provider>.ts` exporting a
`BuiltinProviderConfig`, then register it in
`src/main/providers/builtin/index.ts` (`builtinProviders`, `builtinProviderMap`,
and the named export). `src/main/store/types.ts` re-exports
`builtinProviders as BUILTIN_PROVIDERS`, so there is a single source of truth.

### 2. Forwarder (the extension point)

Create `src/main/proxy/forwarders/<provider>.ts`:

```ts
import { ProviderAdapter } from '../adapters/<provider>'
import { createForwardFailure } from './errors'
import type { ForwarderServices, ProviderForwarder } from './types'

export function createProviderForwarder(services: ForwarderServices): ProviderForwarder {
  return {
    name: '<provider>',
    matches: ProviderAdapter.isProviderProvider,
    async forward(request, account, provider, actualModel, startTime, context) {
      try {
        const transformed = services.transformRequestForPromptToolUse(request, provider)
        // ... call the adapter, translate streams, honor services.shouldDeleteSession()
        return { success: true, status: 200, stream, skipTransform: true, latency }
      } catch (error) {
        return createForwardFailure(error, startTime)
      }
    },
  }
}
```

Register it in `src/main/proxy/forwarders/index.ts`. That is the only shared file
you touch.

### 3. Proxy adapter (+ stream handler)

Implement `src/main/proxy/adapters/<provider>.ts` with a static
`is<Provider>Provider(provider)` predicate and a `chatCompletion(request)`
method. Stream handlers can be co-located. Export from
`src/main/proxy/adapters/index.ts`.

### 4. OAuth adapter

Implement `src/main/oauth/adapters/<provider>.ts` extending `BaseOAuthAdapter`,
then add its factory to the `ADAPTER_FACTORIES` and `SUPPORTED_AUTH_METHODS`
maps in `src/main/oauth/adapters/index.ts`.

### 5. IPC capabilities

If the provider supports extra capabilities (e.g. deleting all chats or reading
credits), register a handler in the `clearChatsHandlers` map in
`src/main/ipc/handlers.ts`.

### 6. UI

Add the icon to `src/renderer/src/assets/providers/<provider>.svg`, map it in
`ProviderCard.tsx`, and add i18n strings to
`src/renderer/src/i18n/locales/{zh-CN,en-US}.json`.

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes (add a forwarder/stream test)
- [ ] Provider appears in the UI and an account can be added
- [ ] Streaming and non-streaming chat work
- [ ] Thinking/web-search modes work if supported
- [ ] Multi-turn session deletion works
