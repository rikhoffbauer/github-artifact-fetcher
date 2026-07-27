# AGENTS.md

## Scope

This repository contains a dependency-free TypeScript downloader and a GitHub Actions workflow that exposes it through `workflow_dispatch` and trusted issue creation.

## Invariants

- Never interpolate workflow input directly into shell commands.
- Accept only HTTP(S) URLs.
- Keep output paths inside `.download-output` and reject traversal.
- Scope secret headers to exact hostnames and recompute them after redirects.
- Stream files; do not buffer whole downloads in memory.
- Preserve `manifest.json` on partial or fatal failure when possible.

## Validation

```bash
npm test
npm run typecheck
```
