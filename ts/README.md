# Mistwatch (TypeScript)

TypeScript port of the Mistwatch proxy. Same HTTP API, config file and SQLite database as the Python version in `../src/mistwatch`; the usage and features are described in `../README.md`.

Requires Node 24 or newer.

## Quick start

```
npx mistwatch setup           # asks a few questions
npx mistwatch serve           # then open http://127.0.0.1:8787/
```

`setup` creates the config, links your Vibe CLI login, creates a client token (shown once) and writes the provider config for Vibe CLI, OpenCode or Pi. Existing files are backed up (`<file>.<timestamp>.bak`) and merged, and it is safe to run again.

Without questions (scripts and AI agents; see `../AGENTS.md`):

```
npx mistwatch setup --yes --harness vibe          # or opencode, pi, vibe,opencode,pi, all
```

Options: `--start` runs the proxy afterwards, `--json` prints what was done (token masked, `--show-token` includes it), `--no-banner`, `--force` replaces `config.toml`. Set the printed token as `MISTWATCH_TOKEN` so the tools can use it.

From a checkout:

```
npm install
npm run build
node dist/cli.js setup
node dist/cli.js serve        # then open http://127.0.0.1:8787/
```

Development: `npm run dev -- <command>`, checks: `npm run check` (typecheck, Biome, Vitest).

Differences from the Python version, all on purpose:

- A budget reservation is taken atomically before the upstream call, so parallel requests cannot overspend.
- Only connect failures are retried; accounted paths match on whole path segments.
- Host and Origin checks against DNS rebinding, request rate limits, a bounded upstream queue and body limits.
