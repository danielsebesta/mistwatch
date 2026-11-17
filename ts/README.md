# Mistwatch (TypeScript)

TypeScript port of the Mistwatch proxy. Same HTTP API, config file and SQLite database as the Python version in `../src/mistwatch`; the usage and features are described in `../README.md`.

Requires Node 24 or newer.

```
npm install
npm run build
node dist/cli.js serve        # then open http://127.0.0.1:8787/
```

Development: `npm run dev -- <command>`, checks: `npm run check` (typecheck, Biome, Vitest).

Differences from the Python version, all on purpose:

- A budget reservation is taken atomically before the upstream call, so parallel requests cannot overspend.
- Only connect failures are retried; accounted paths match on whole path segments.
- Host and Origin checks against DNS rebinding, request rate limits, a bounded upstream queue and body limits.
