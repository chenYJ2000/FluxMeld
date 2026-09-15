# Changelog

All notable changes to FluxMeld are documented here.

## [Unreleased]

### Added

- Provider forwarder plugin registry: each provider now implements
  `ProviderForwarder` in `src/main/proxy/forwarders/<provider>.ts` and registers
  in `forwarders/index.ts`. Adding a provider no longer requires editing
  `forwarder.ts`.
- Type checking for the main, renderer, and headless server/web projects
  (`npm run typecheck`, `tsconfig.{node,renderer,server}.json`).
- ESLint (flat config) and Prettier with `lint` / `format` scripts.
- Test coverage script (`npm run test:coverage`).
- Behavioral forwarder-registry tests
  (`tests/providers/forwarder-registry.test.ts`).
- Documentation: `docs/architecture/overview.md`,
  `docs/architecture/provider-plugin.md`, `TESTING.md`, `CONTRIBUTING.md`, and
  this changelog.

### Changed

- Unified duplicated domain types: `src/shared/types.ts` is now the single
  source for `Provider`, `Account`, `AppConfig`, and related types, re-exported
  by `src/main/store/types.ts`.
- Replaced the OAuth adapter factory switch with a registry map.
- Fixed 117 pre-existing TypeScript errors and added ES2023 lib for
  `Array.prototype.findLastIndex`.
- Application quit state is tracked in `src/main/lib/appLifecycle.ts` instead of
  monkey-patching Electron's `App`.
- CI now runs typecheck and lint before tests and build.

### Fixed

- Windows-specific test failures in the skills test suite (ESM `file://` URL for
  spawned child processes; CRLF frontmatter matching).
- Incorrect `PerplexityStreamHandler` barrel export and stale module paths.
- Missing `language` default in the application config.
