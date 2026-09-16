# Egress Source Plugin Guide

This guide describes the outbound-proxy ("egress") module architecture. The
goal: **adding a new way of producing proxy exits should only touch a new source
folder plus one registry line.**

## Concepts

| Term | Meaning |
| --- | --- |
| **source** | a pluggable provider of proxy exits (`clash`, `config-file`, future IP pool) |
| **exit** | one concrete usable outbound proxy (`protocol`/`host`/`port`/credentials) |
| **exit pool** | the ordered set of exits a source exposes |
| **allocator** | the global cursor handing exits to groups (skip in-use, wrap when saturated) |
| **group** | a set of accounts sharing one exit (rendered as a column) |
| **direct group** | accounts with no exit (strict direct connection) |

## Layout

```
src/main/egress/
├── types.ts                 # EgressSourceModule / EgressSource / EgressExit contracts
├── registry.ts              # the single registration point
├── manager.ts               # EgressManager: allocation + per-request routing
├── allocation.ts            # ExitAllocator (cursor + wrap)
├── context.ts               # AsyncLocalStorage request-scoped egress
├── http.ts                  # axios injection + createEgressAxios()
├── index.ts                 # initializeEgress() bootstrap
├── common/
│   ├── rotation/            # ExitPool, orderExits, RotationScheduler
│   ├── verification.ts      # verifyExit
│   └── discovery.ts         # env proxy parsing + TCP probing
├── clash/                   # Clash/mihomo controller source
└── config-file/             # JSON config-file source
```

## How requests are proxied

The forwarder wraps each upstream attempt in `runWithEgress(exit, fn)`
(`context.ts`). A single axios request interceptor — installed on the default
axios export and on instances created via `createEgressAxios` — reads that exit
and applies it to **that request only**. Global `axios.defaults.proxy` is never
mutated, so concurrent accounts can use different exits.

- HTTP/HTTPS exits → axios `proxy` config.
- SOCKS exits → `socks-proxy-agent` via `httpAgent`/`httpsAgent`.
- `minimax`'s `http2.connect` path bypasses axios and stays direct.

## Contracts

See `src/main/egress/types.ts`. A source module is:

```ts
export interface EgressSourceModule {
  readonly meta: EgressSourceModuleMeta   // id, i18n keys, fields[], capabilities
  createSource(services: EgressServices): EgressSource
}
```

A source instance only has to expose its exits and apply a chosen one:

| Method | Purpose |
| --- | --- |
| `probe()` | is the source usable right now? |
| `listExits()` | enumerate available exits (ordered as preferred) |
| `apply(exit)` | make an exit effective (Clash: switch node; file: no-op) |
| `deactivate()` | restore previous network state |
| `verifyExit?(exit)` | optional source-specific verification |

The manager owns allocation and rotation, so a source normally reuses the shared
`ExitAllocator`. A source may override rotation behaviour when its protocol
requires it (Clash switches controller nodes; the file source is a no-op).

## Registration

1. Create `src/main/egress/<id>/` with `index.ts`, `config.ts`, `source.ts`
   (and helpers, e.g. `parser.ts`).
2. Add the module to `egressSourceModules` in `src/main/egress/registry.ts`.
3. Field descriptors on `meta.fields` drive the generic settings UI — no
   renderer branch is needed.
4. Add i18n strings under `egress.sources.<id>.*` in
   `src/renderer/src/i18n/locales/{zh-CN,en-US}.json`.

## Proxy assignment (Phase 2)

Each provider stores `proxyAssignment: Record<accountId, exitId | null>`.
`EgressManager.resolveExitForAccount()` maps an account to its group's exit;
`null` means strict direct (never silently promoted to a proxy).

- **Auto assign** chunks a provider's accounts by `maxAccountsPerGroup` and
  allocates one exit per chunk through `ExitAllocator` (creating as many groups
  as needed; the pool wraps when saturated).
- **Manual moves** may only go group → direct → group; the renderer enforces it
  and the backend validates group capacity.
- Failure of a grouped request calls `rotateExit()`; a direct-group account is
  left direct. Providers with no assignment map at all fall back to the global
  on-demand proxy.

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes (add source tests under `tests/egress/`)
- [ ] Source appears in the "Proxy Sources" page and can be made active
- [ ] Exits are listed and rotation works
- [ ] Assignment grouping routes accounts through the expected exits
