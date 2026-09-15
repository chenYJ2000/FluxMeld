# Testing

## Running tests

```bash
npm test                # all tests
npm run test:coverage   # all tests with Node's experimental coverage
```

Tests use the **Node.js built-in test runner** (`node:test` +
`node:assert/strict`). TypeScript is loaded through `tsx`. Discovery is handled
by `scripts/run-tests.mjs`, which recursively collects `tests/**/*.test.{js,mjs,ts}`
and runs them through `node --import tsx --test`. Extra Node flags are forwarded:

```bash
node scripts/run-tests.mjs --experimental-test-coverage
```

There is no Jest/Vitest/Mocha configuration — do not add one without removing the
custom runner.

## Test layout

```
tests/
├── providers/     Provider configs, adapters, streams, forwarder registry
├── proxy/         Request lifecycle, timeouts, outbound proxy, context management
├── tool-calling/  Tool-calling engine, parsers, repair, client adapters
├── request-logs/  Request log persistence + sanitizer
├── app-logs/      App log persistence
├── updater/       In-app update flow
├── build/         Build scripts
└── skills/        Agent skill scripts and docs
```

## Conventions

- Import source with an explicit `.ts` extension (e.g.
  `../../src/main/proxy/forwarders/index.ts`).
- Mock by monkey-patching the `storeManager` singleton and restoring in
  `t.after(...)`; see `tests/providers/loadbalancer.test.ts`.
- Replace the axios instance via `(adapter as any).axiosInstance = { ... }` as in
  `tests/providers/qwen-ai-stream.test.ts`.
- Prefer behavioral tests over assertions that read source files with regex.
  A small number of source-contract tests remain where a behavioral test would
  require running the whole Electron runtime; keep them minimal and stable.

## Adding a provider test

Implement a forwarder/stream test alongside
`tests/providers/forwarder-registry.test.ts`, and add a stream test modeled on
`tests/providers/glm-stream.test.ts`.
