# Instructions for AI agents

Mistwatch is a local proxy in front of Mistral AI. It tracks the Vibe Code and Studio (API) budgets and offers an `auto` model. When the user says **"set this up"**, follow this file. The same text is served by a running proxy at `/llms.txt`.

## Prerequisites

- Node 24 or newer: run `node -v`. If it is older, stop and tell the user to upgrade Node.
- For the Vibe CLI path, the user must have signed in to Vibe once (`vibe --setup`). Setup checks this and tells you if it is missing.

## Set up

Run one command. It never prompts, and you can run it again safely.

```
npx mistwatch setup --yes --harness vibe
```

Other tools: `--harness opencode`, `--harness pi`, or a list such as `--harness vibe,opencode`. Add `--port N` if the default port 8787 is taken. From a git checkout use `npm install && npm run build && node dist/cli.js setup --yes --harness vibe`.

Setup does this, in order:

1. Creates `~/.mistwatch/config.toml` if it is missing (`MISTWATCH_HOME` or `MISTWATCH_CONFIG` change the location).
2. Imports the Vibe CLI login from the OS keyring as an account.
3. Creates a client token (`mw-...`) if there is none, and prints it **once**. (With `--json` no token is created unless you also pass `--show-token`, because a masked token could never be recovered.)
4. Writes the provider config of each chosen tool: `~/.vibe/config.toml`, `~/.config/opencode/opencode.json` (`$XDG_CONFIG_HOME/opencode/opencode.json` when that variable is set; not on Windows) or `~/.pi/agent/models.json`. An existing file is copied to `<file>.<timestamp>.bak` first, then merged, never replaced. A file that is already correct is left alone.
5. Checks the local status and prints `OK`.

A non-zero exit code means a step failed; the output says which one and why. Warnings (`[warn]`) do not fail the run.

The token is passed to tools through the environment variable `MISTWATCH_TOKEN`. Tell the user to store it somewhere safe and set it (Windows: `setx MISTWATCH_TOKEN <token>` and open a new terminal; macOS/Linux: `export MISTWATCH_TOKEN=<token>` in their shell profile). If the user agrees you may run `setx` for them on Windows. Do not edit shell profiles yourself.

## Verify

1. `npx mistwatch status` lists the accounts and budgets (budgets appear after the first sync).
2. The proxy must be running for tools to work. Ask the user before you start it, because it keeps running: `npx mistwatch serve` (web UI at http://127.0.0.1:8787/).
3. With the proxy running, check the token end to end:
   - macOS/Linux: `curl -s -H "Authorization: Bearer $MISTWATCH_TOKEN" http://127.0.0.1:8787/v1/models`
   - PowerShell: `curl.exe -s -H "Authorization: Bearer $env:MISTWATCH_TOKEN" http://127.0.0.1:8787/v1/models`

   A JSON list of models means it works.

## If the Vibe login is missing

Setup prints `[warn] Vibe login`. Ask the user to run `vibe --setup` in their own terminal (it asks for their Mistral key), then run `npx mistwatch import-vibe`. Or they can add a key in the web UI under Accounts after `mistwatch serve`. Never ask for the key in chat.

## Rules

- Never ask the user to paste API keys or tokens into the chat, and never put one in a command line you show back to them.
- Show the client token only once, right after it is created. Do not print it again; later runs mask it. If it is lost, create a new key under "API keys" in the web UI.
- Back up before you change a config: setup does this for you. If you edit by hand, copy the file to a `.bak` first.
- Do not edit files outside the harness config that setup writes.
- Ask before starting `serve` or any other long-running process.
- Use the model name `auto` unless the user wants a specific model. On `429`, wait for `Retry-After`; do not switch models to get around it.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `[fail]` for OpenCode or Pi: "not plain JSON" | The file has comments. It was left untouched. Run `npx mistwatch agent-config opencode` (or `pi`) and have the user merge the printed block. |
| `[fail]` for Vibe: "not valid TOML" | Same: the file is untouched. Run `npx mistwatch vibe-config` and have the user add the block. |
| `... not found - run mistwatch init first` | Run `npx mistwatch setup --yes`. |
| Port 8787 already in use | Run `npx mistwatch setup --yes --harness vibe --port N`: it writes the port into `config.toml` (backup kept) and into the tool configs. `serve --port N` alone is only for that one run; it changes neither `config.toml` nor the tool URLs. If you edit `[server] port` by hand, run setup again so the tools get the new URL. |
| `401` from the proxy (`mistwatch_auth`) | `MISTWATCH_TOKEN` is unset, stale or wrong. Open a new terminal after `setx`. |
| `429` (`mistwatch_budget_exhausted`) | No account has room right now. Wait for `Retry-After` seconds. |
| `curl: connection refused` | The proxy is not running. Ask the user, then start `serve`. |
| No Vibe login on Linux | The keyring needs libsecret. Add the key in the web UI instead. |
| A fix from a new version has no effect | An older proxy is still answering on the port (an earlier `serve`, Docker or a global install). Every response has an `x-mw-version` header (`curl.exe -si http://127.0.0.1:8787/v1/billing/budget`); compare it with `npx mistwatch@latest --version`, stop the old process and start `serve` again. |
| Wrong config written | Restore the newest `<file>.<timestamp>.bak` next to it. |
| `Your Mistral sign-in cannot be used for http://127.0.0.1:...` in Vibe Desktop | The Desktop only uses its own Mistral sign-in for a `backend = "mistral"` provider. Run `npx mistwatch setup --yes --harness vibe --desktop`: it writes the provider as `generic` (so `MISTWATCH_TOKEN` is used) plus a header that makes Mistwatch return thinking as `reasoning_content`. Restart the Desktop afterwards. The Vibe budget footer is not available in this mode; later plain runs keep it. |
| Raw `{'type': 'thinking', ...}` text in Vibe Desktop answers | The provider lacks `extra_headers = { x-mw-flat-content = "1" }`. Run setup with `--desktop`. |

Claude Code and current Codex CLI cannot use Mistwatch directly (they need the Anthropic Messages or OpenAI Responses format). Say so instead of trying to configure them.
