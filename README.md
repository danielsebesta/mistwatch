<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danielsebesta/mistwatch/main/web/public/logo-dark.svg">
    <img src="https://raw.githubusercontent.com/danielsebesta/mistwatch/main/web/public/logo.svg" alt="Mistwatch" height="48">
  </picture>
</p>

<p align="center">A local proxy for Mistral AI that tracks your budgets and gives your coding tools one <code>auto</code> model.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mistwatch"><img alt="npm" src="https://img.shields.io/npm/v/mistwatch?color=ff8204&logo=npm"></a>
  <a href="https://www.npmjs.com/package/mistwatch"><img alt="downloads" src="https://img.shields.io/npm/dm/mistwatch?color=ff8204"></a>
  <a href="https://github.com/danielsebesta/mistwatch/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/danielsebesta/mistwatch/ci.yml?branch=main&label=CI"></a>
  <a href="https://github.com/danielsebesta/mistwatch/pkgs/container/mistwatch"><img alt="Docker" src="https://img.shields.io/badge/docker-ghcr.io-2496ed?logo=docker&logoColor=white"></a>
  <img alt="Node 24+" src="https://img.shields.io/node/v/mistwatch?color=339933&logo=node.js&logoColor=white">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/npm/l/mistwatch?color=blue"></a>
</p>

> **Unofficial tool.** Mistwatch is an independent project. It is not a product of Mistral AI and is not affiliated with, endorsed by or sponsored by it. "Mistral" is a trademark of Mistral AI and is used here only to describe the service the tool talks to.

## What it does

- **Tracks your budgets.** It shows how much of your Vibe Code and Studio (API) allowance you have used, per 5 hours, day, week and month.
- **Spreads usage over time.** It paces requests so you do not burn a whole month's allowance in one afternoon. When nothing is left it answers `429` with a `Retry-After` header.
- **Offers an `auto` model.** It picks a suitable Mistral model for each request.
- **Pools several accounts.** Requests go to whichever account still has room.
- **Works with your tools.** OpenCode, Pi and the Vibe CLI, or anything that speaks the OpenAI chat API.

## Quick start

You need Node 24 or newer. Use whichever package manager you like:

```sh
npx mistwatch setup        # npm
pnpm dlx mistwatch setup   # pnpm
yarn dlx mistwatch setup   # yarn (Berry)
bunx mistwatch setup       # bun
```

Setup creates the config, imports your Vibe login, creates a client token (shown once) and writes the config of your tools. Then start the proxy and open the web UI:

```sh
npx mistwatch serve        # http://127.0.0.1:8787/
```

To install it globally instead: `npm i -g mistwatch`, `pnpm add -g mistwatch`, `yarn global add mistwatch` or `bun add -g mistwatch`, then run `mistwatch`.

Your tools read the client token from the `MISTWATCH_TOKEN` environment variable. Set it as setup tells you.

For scripts and AI agents there is a non-interactive form: `mistwatch setup --yes --harness vibe` (or `opencode`, `pi`). See [AGENTS.md](AGENTS.md).

### Docker

```sh
docker run -d --name mistwatch -p 127.0.0.1:8787:8787 -v mistwatch:/data ghcr.io/danielsebesta/mistwatch
```

Publish the port on `127.0.0.1` as shown, so the UI is not exposed to your network. The container keeps its config and database in the `mistwatch` volume. Open <http://127.0.0.1:8787/>, create your login and add your keys there.

With Docker Compose (`docker-compose.yml` in this repo), set `MISTWATCH_BIND` to the address to publish on (for example your Tailscale IP; default `127.0.0.1`) and `MISTWATCH_ALLOWED_HOSTS` to the host names you open it under, then run `docker compose up -d --build`.

## Web UI

- **Overview**: Vibe and Studio budgets, limits per period, a spending chart and recent requests.
- **Accounts**: your Mistral accounts, each with a Vibe key (can be taken over from the Vibe CLI in one click) and a Studio API key. A key is checked before it is saved.
- **API keys**: `mw-…` keys for your tools. A key is shown only once, when you create it. The same page has ready-made configs for OpenCode, Pi and the Vibe CLI, plus environment variables for other tools.
- **Settings**: change your password, add users and rename models in charts and tables.

## Connecting your tools

`mistwatch setup` does it in one go. You can also do one tool at a time:

```sh
mistwatch agent-config opencode --write
mistwatch agent-config pi --write
mistwatch vibe-config
```

Claude Code and current Codex CLI do not work directly, because they need the Anthropic Messages or OpenAI Responses format and Mistral offers neither. Put a translating proxy such as LiteLLM in front of Mistwatch if you need them.

Agents and integrators can read `/llms.txt` on a running proxy (no sign-in needed). It describes the address, authentication, the `auto` models and the `401` and `429` errors.

## Commands

| Command | What it does |
| --- | --- |
| `setup` | One-step setup for your tools |
| `serve` | Run the proxy and web UI (`--port`) |
| `status` | Show the budget of every account |
| `sync` | Pull budget usage from Mistral now |
| `route "prompt"` | Show which model `auto` would pick |
| `import-vibe` | Add the Vibe CLI login as an account |
| `passwd <user>` | Create a user or reset a password |
| `init` | Write a fresh config file |

## Configuration

Settings live in `~/.mistwatch/config.toml` (server address and port, limits, prices, the `auto` router). Set `MISTWATCH_HOME` to keep it somewhere else. Accounts and keys are stored in the database, not in the config file.

To reach the UI under another host name, for example through a tunnel, add it to `allowed_hosts` under `[server]`. In Docker, set `MISTWATCH_ALLOWED_HOSTS` instead (comma separated, for example `mw.tailnet.ts.net,100.64.0.1`); it is added to the list from the file.

To point Vibe, OpenCode or Pi at a Mistwatch running on another machine, run `mistwatch setup --yes --harness vibe --url http://HOST:8787` on the machine with the tool. The `/v1` part is added for you.

## Security

- Passwords are hashed with salted scrypt. Sessions and proxy keys are stored only as SHA-256 hashes.
- Mistral keys have to be forwarded, so they cannot be hashed. They are kept in your system keyring (Windows Credential Manager, macOS Keychain, libsecret). The database holds only a reference. The Docker image has no keyring and stores them in the data volume instead.
- Cookies are `HttpOnly` and `SameSite=Strict`, and five failed sign-ins lock an account for 60 seconds.
- The server listens on `127.0.0.1` only. If you expose it to a network, put a reverse proxy with HTTPS in front.
- Forgot your password? Run `mistwatch passwd <username>`.

## Development

```sh
npm ci
npm run check    # typecheck, lint, tests
npm run build    # dist/cli.js and dist/web
```

The logo, favicons and colour palette are generated from `brand/` (`npx tsx brand/build.ts`, `npx tsx brand/contrast.ts`).

## Licence

[MIT](LICENSE)
