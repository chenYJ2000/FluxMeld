# Contributing

Thanks for contributing to FluxMeld.

## Prerequisites

- Node.js 18+ (CI uses Node 22)
- npm

## Setup

```bash
npm ci
npm run dev:win    # Windows
npm run dev        # macOS/Linux
```

## Before you push

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

All four must pass; CI enforces them (`.github/workflows/ci.yml`).

## Code style

- TypeScript with strict typing. Prefer explicit types at module boundaries.
- **Immutability**: return new objects instead of mutating inputs.
- No comments unless they add non-obvious intent.
- Prettier owns formatting (`npm run format`). ESLint owns correctness rules.
- Follow the provider-plugin extension pattern in
  `docs/architecture/provider-plugin.md` rather than editing shared
  orchestration for a single provider.

## Commit messages

Use conventional prefixes scoped to the area, e.g.:

```
feat(proxy): add Foo provider forwarder
fix(store): preserve credential fields on provider sync
refactor(forwarder): extract provider strategies into forwarders/
docs: document provider plugin registry
```

Do not commit generated artifacts (`out/`, `dist/`).
