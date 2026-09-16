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
├── config-file/             # JSON config-file source
└── ip-pool/                 # Proxy-layer gateway IP pool source (leased exits)
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
| `deactivate()` | restore previous network state (leased sources release their leases) |
| `verifyExit?(exit)` | optional source-specific verification |
| `acquireExit?(signal)` | optional: lease one fresh exit on demand (IP pools) |
| `disposeExit?(exit)` | optional: delete/release a leased exit the manager drops |

The manager owns allocation and rotation, so a source normally reuses the shared
`ExitAllocator`. A source may override rotation behaviour when its protocol
requires it (Clash switches controller nodes; the file source is a no-op).

## Leased sources (IP pool)

Sources whose exits must be leased (and may expire) implement the optional
`acquireExit()` / `disposeExit()` hooks. The manager detects them via
`isAcquireMode` and switches selection strategy:

- `acquireExit(signal)` is called per candidate (bounded by `maxExitAttempts` /
  the source default); the manager applies and verifies the leased exit, and
  calls `disposeExit()` when it is unusable or replaced. A blocked acquisition
  is aborted through the signal when the proxy is disabled or the source
  changes.
- `listExits()` becomes a read-only view of currently-held leases (used by the
  UI); the manager never fills a pool from it.
- rotation deletes the previous IP (`disposeExit`) before leasing a new one;
  `deactivate()` returns every held lease.
- `refreshPool`, the empty-table guard, and expiry scheduling behave as for
  table sources (the IP pool sets `expiresAt` from `created_at + ttl`).

The `ip-pool` source talks to the proxy-layer gateway (`USAGE.md`):
`POST /{site}/ips/acquire?strategy=remaining_desc&min_remaining_sec=...`,
`DELETE /{site}/ips/{id}` (change IP), `POST /{site}/ips/{id}/release`
(deactivate) and `GET /{site}/count` (probe). Unsupported protocols (`socks4`)
are deleted and re-acquired; an empty pool (`40402`) is retried every
`emptyPoolWaitMs` until aborted.

Each source implements its own `probe()` connectivity check (Clash: controller +
proxy port; config-file: file exists + parses). The "Proxy Sources" page exposes
a per-source **Check** button that calls `outboundProxy:checkSource` →
`EgressManager.checkSource(config)`, which builds a throwaway instance of that
source and runs `probe()` (using the draft settings, so unsaved edits can be
tested).

## Resilience

- **Single-flight activation**: concurrent requests share one activation attempt
  (`activate()` / `activationPromise`), so they never race on the shared exit
  allocator or thrash the source. Per-group allocation is single-flight too
  (`Map<groupId, Promise>`), so a group never gets two exits.
- **Table-scan selection**: each activation/rotation re-reads the source's exit
  table (Clash `/proxies`, in original order). Starting at the shared cursor it
  scans entries and consumes one candidate for: non-selectable entries (policy
  groups, DIRECT/REJECT, banners) and already-in-use exits; dead entries
  (`alive === false`) are skipped *without* consuming a candidate; a selectable
  live entry is applied then verified (apply-before-verify, needed because Clash
  exits share one endpoint), and a failed test consumes a candidate. On success
  the entry is claimed and the cursor advances past it; on total failure the
  previous exit is re-applied.
- **Candidate budget**: `maxExitAttempts`; `0` (auto) uses the source's
  `meta.defaultMaxExitAttempts` (`'all'` = whole table length; Clash `'all'`,
  config-file / IP pool `10`).
- **Cooldown**: a failed activation backs off (1s doubling to 30s) so a down
  source is not hammered; it resets on success, manual enable, config save, or a
  successful source check.
- **Generation guard**: `invalidateSource()`/mode switches bump a generation and
  clear in-flight promises; stale async results are discarded.
- **Rotation throttle**: `rotateProxy`/`rotateGroup` are single-flight and
  rate-limited (3s) to avoid Clash node thrash affecting in-flight requests.
- **Fail fast**: with `enabled` and group assignment off, if no exit can be
  activated the request fails with `503` (`EgressUnavailableError`) instead of
  silently falling back to a (possibly blocked) direct connection.

These knobs live on `outboundProxy.rotation` and are editable on the "Rotation
Policy" page: `verifyTimeoutMs` (2000), `maxExitAttempts` (0 = auto),
`rotateMinIntervalMs` (3000), `cooldownBaseMs` (1000), `cooldownMaxMs` (30000).
An *activation failure* (which drives the cooldown) is any of: no source
configured; source probe unavailable; empty exit table; no usable exit found
within the candidate budget.

## Registration

1. Create `src/main/egress/<id>/` with `index.ts`, `config.ts`, `source.ts`
   (and helpers, e.g. `parser.ts`).
2. Add the module to `egressSourceModules` in `src/main/egress/registry.ts`.
3. Field descriptors on `meta.fields` drive the generic settings UI — no
   renderer branch is needed. A descriptor declares `key`, `type`
   (`text` | `textarea` | `password` | `number` | `boolean` | `file` |
   `select`), i18n `labelKey`/`helpKey`, optional `placeholder`,
   `defaultValue`, `min`/`max`/`step` (number), `options` (select) and a
   `visibleWhen` rule (`{ key, equals?, in? }`) to show a field only when
   another field's value matches. A `file` field renders a native picker
   button (Electron only; the web build falls back to a text input).
4. Add i18n strings under `egress.sources.<id>.*` in
   `src/renderer/src/i18n/locales/{zh-CN,en-US}.json`.

## Proxy assignment (Phase 2)

`OutboundProxySettings.groupAssignmentEnabled` selects the routing mode:

| enabled | groupAssignmentEnabled | Behaviour |
| --- | --- | --- |
| false | — | everything direct |
| true | false | all accounts share one proxy exit (Clash use case) |
| true | true | route by group; the direct group stays strictly direct |

Groups (`OutboundProxySettings.groups: ProxyGroup[]`) are **global**: the same
group across providers shares one dynamically assigned exit. Each provider
stores `proxyAssignment: Record<accountId, groupId | null>`; `null`/absent means
the direct group.

- **Dynamic binding** (runtime only): `EgressManager.groupExits` maps groupId to
  an exit allocated through the shared `ExitAllocator` (skips in-use exits, wraps
  when saturated). `ensureGroupExit()` allocates lazily; `rotateGroup()`
  reallocates on failure. If no exit is available the request falls back to
  direct with a warning.
- **Auto assign** fills the provider's currently-unassigned accounts into
  existing groups (skipping full ones, creating new groups when all are full).
  The per-group limit and the counting scope (`global` across all providers or
  `provider`-only) are chosen per run; groups themselves have no hard cap.
- **Manual moves** use the swap panel (pick left/right group, double-click an
  account to move it across). Deleting a group moves its accounts to the direct
  group.
- Clash cannot run distinct concurrent exits per group (a single GLOBAL node),
  so group assignment is intended for config-file / IP-pool sources; for Clash
  leave group assignment off.

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes (add source tests under `tests/egress/`)
- [ ] Source appears in the "Proxy Sources" page and can be made active
- [ ] Exits are listed and rotation works
- [ ] Assignment grouping routes accounts through the expected exits
