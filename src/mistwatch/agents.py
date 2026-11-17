"""Config snippets that point coding agents at the proxy, and the public llms.txt."""
from __future__ import annotations

import json

from .modelnames import autoname, builtin
from .router import LADDER

ENV = "MISTWATCH_TOKEN"


def models() -> list[tuple[str, str, int, bool]]:
    """(id, display name, context, vision): the `auto` family plus every model the router can pick."""
    out = [("auto", "Auto (budget-aware router)", 262_144, True),
           ("auto-fast", "Auto, cheaper models only", 262_144, True),
           ("auto-max", "Auto, aims for quality", 1_048_576, True)]
    seen = set()
    for st in LADDER:
        if st.model not in seen:
            seen.add(st.model)
            out.append((st.model, builtin(st.model) or autoname(st.model), st.ctx, st.vision))
    return out


def pi(base: str, env: str = ENV) -> dict:
    return {"providers": {"mistwatch": {
        "baseUrl": f"{base}/v1", "api": "openai-completions", "apiKey": env,
        "models": [{"id": i, "name": n, "reasoning": i != "mistral-small-2603", "input": ["text", "image"] if v else ["text"],
                    "contextWindow": c, "maxTokens": 32_768} for i, n, c, v in models()]}}}


def opencode(base: str, env: str = ENV) -> dict:
    return {"$schema": "https://opencode.ai/config.json", "provider": {"mistwatch": {
        "npm": "@ai-sdk/openai-compatible", "name": "mistwatch",
        "options": {"baseURL": f"{base}/v1", "apiKey": "{env:%s}" % env},
        "models": {i: {"name": n, "limit": {"context": c, "output": 32_768}} for i, n, c, v in models()}}}}


def vibe(base: str, env: str = ENV) -> str:
    return f"""[[providers]]
name = "mistwatch"
api_base = "{base}/v1"
api_key_env_var = "{env}"
backend = "mistral"

# Then set provider = "mistwatch" on the models you use.
"""


def merge(dst: dict, src: dict) -> dict:
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            merge(dst[k], v)
        else:
            dst[k] = v
    return dst


# tool -> (label, file the snippet belongs in, language)
TOOLS = {
    "opencode": ("OpenCode", "~/.config/opencode/opencode.json", "json"),
    "pi": ("Pi", "~/.pi/agent/models.json", "json"),
    "vibe": ("Vibe CLI", "~/.vibe/config.toml", "toml"),
    "env": ("Other tools", "environment", "sh"),
}


def render(tool: str, base: str, env: str = ENV) -> dict:
    label, path, lang = TOOLS[tool]
    if tool == "opencode":
        text = json.dumps(opencode(base, env), indent=2) + "\n"
        note = "Merge this into the file, or run: mistwatch agent-config opencode --write"
    elif tool == "pi":
        text = json.dumps(pi(base, env), indent=2) + "\n"
        note = "Merge this into the file, or run: mistwatch agent-config pi --write"
    elif tool == "vibe":
        text, note = vibe(base, env), "Add this to the file."
    else:
        text = f'export OPENAI_BASE_URL="{base}/v1"\nexport OPENAI_API_KEY="${env}"\n'
        note = "Any tool that speaks the OpenAI chat completions API. Use the model name \"auto\"."
    return {"tool": tool, "label": label, "path": path, "language": lang, "content": text,
            "filename": path.rsplit("/", 1)[-1] if "/" in path else "mistwatch.env",
            "note": note + f" Set {env} to a key from the API keys page."}


def llms_txt(base: str) -> str:
    return f"""# Mistwatch

> A local gateway in front of Mistral AI. It speaks the OpenAI/Mistral chat completions API, tracks the Vibe Code and Studio (API) budgets, spreads spending over time and can pick the model for you (`auto`). Unofficial: not affiliated with Mistral AI.

## Connect

- Base URL: `{base}/v1`
- Auth: `Authorization: Bearer mw-...` (or `x-api-key`). Create keys in the web UI under "API keys". Without any key the gateway is open to the local machine.
- Format: Mistral/OpenAI chat completions, including streaming and tool calls. `POST /v1/chat/completions`, `/v1/fim/completions`, `/v1/embeddings`, `/v1/ocr`, `/v1/moderations` and `/v1/conversations` are counted against the budget. Every other path is forwarded without accounting.
- Not offered: Anthropic Messages (`/v1/messages`) and OpenAI Responses (`/v1/responses`). Mistral does not serve them, so Claude Code and current Codex CLI need a translating proxy (for example LiteLLM) in front, or their own provider.

## Models

- `auto` picks a model and reasoning effort from how hard the request is and how much budget is left.
- `auto-fast` stays with cheaper models, `auto-max` aims higher.
- Any Mistral model id is forwarded unchanged. `GET /v1/models` lists the upstream models.

## What a client should handle

- `401` with `error.type = "mistwatch_auth"`: the key is wrong or revoked.
- `429` with `error.type = "mistwatch_budget_exhausted"`: no account has room right now. Wait for the `Retry-After` header (seconds) instead of retrying at once. The body lists each pool and when it frees up.
- Requests whose `User-Agent` contains `Mistral-Vibe` are charged to the Vibe Code budget, all others to the Studio API budget. If one is used up, the other is tried.
- Response headers on accounted calls: `x-mw-account`, `x-mw-pool`, `x-mw-room-eur` (what can still be spent now) and, for `auto`, `x-mw-routed` (the model and effort chosen).

## Set up a tool

- OpenCode: `mistwatch agent-config opencode --write`
- Pi: `mistwatch agent-config pi --write`
- Vibe CLI: `mistwatch vibe-config`
- Any other OpenAI-compatible tool: base URL `{base}/v1`, key from the API keys page, model `auto`.
- The same snippets can be copied or downloaded from the web UI: {base}/#/keys

## Building an integration

- Read the key from an environment variable (`{ENV}`); never write it into a file you commit.
- Default to the model `auto` and let the gateway choose.
- On `429`, show the user the wait time from `Retry-After`. Do not switch models to get around it.
- Use one key per tool so its usage shows up separately under "Spend by key".
"""
