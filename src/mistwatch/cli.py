"""mistwatch command line."""
from __future__ import annotations

import argparse
import asyncio
import json
import secrets
import sys
import time
from datetime import datetime

import httpx

from . import agents
from . import config as C

TEMPLATE = """\
# mistwatch config (server, limits, pricing). Accounts, keys and logins are managed in the web UI.
[server]
host = "127.0.0.1"
port = 8787

[upstream]
base_url = "https://api.mistral.ai"

[pricing]
usd_to_eur = 0.86          # docs prices are USD, budgets are EUR

[limits]
reserve_pct = 3.0          # untouchable slice of every pool's monthly budget
burst_5h = 2.0             # x fair pace allowed within any 5h window
burst_day = 1.5
burst_week = 1.25
sync_interval_s = 300
strategy = "most_headroom" # or "priority"
fallback_to_other_pool = true
vibe_user_agent_regex = "Mistral-Vibe"

[router]
llm_classifier = true      # ask a tiny model to rate prompt difficulty for `auto`
classifier_model = "ministral-3b-latest"
"""

def open_app(cfg=None):
    """Config + DB + store, with accounts loaded from the DB (shared by the CLI commands)."""
    from .db import DB
    from .store import Store

    cfg = cfg or C.load()
    db = DB(cfg.db_path)
    store = Store(db)
    store.migrate_config(cfg)
    cfg.accounts[:] = store.list_accounts()
    return cfg, db, store


def cmd_init(a):
    p = C.config_path()
    if p.exists() and not a.force:
        print(f"{p} already exists (use --force)")
        return 1
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(TEMPLATE, encoding="utf-8")
    print(f"wrote {p}")
    if a.import_vibe:
        return cmd_import_vibe(argparse.Namespace(name="vibe-login"))
    print("Next: `mistwatch serve`, then open the web UI to create your login and add keys.")
    return 0


def cmd_import_vibe(a):
    """Add the Vibe CLI login as an account (stored as a keyring reference - the key is not copied)."""
    from .store import VIBE_REF, StoreError, vibe_cli_key_present

    if not vibe_cli_key_present():
        print("No Vibe CLI key found in the OS keyring (run `vibe --setup` first).")
        return 1
    cfg, db, store = open_app()
    try:
        if not store.get_account(a.name):
            store.create_account(a.name)
        store.set_key(a.name, "vibe", ref=VIBE_REF)
    except StoreError as e:
        print(e)
        return 1
    print(f"account {a.name!r} now follows the Vibe CLI login")
    return 0


def cmd_passwd(a):
    """Create a user or reset a password (recovery path when you are locked out of the web UI)."""
    import getpass

    from .store import StoreError

    cfg, db, store = open_app()
    pw = getpass.getpass("New password: ")
    if pw != getpass.getpass("Again: "):
        print("Passwords differ.")
        return 1
    try:
        u = store.find_user(a.username)
        if u:
            store.set_password(u["id"], pw)
            store.delete_other_sessions(u["id"], None)
        else:
            store.create_user(a.username, pw)
    except StoreError as e:
        print(e)
        return 1
    print("ok")
    return 0


def _fmt_ts(ts):
    return datetime.fromtimestamp(ts).strftime("%d.%m. %H:%M") if ts else "-"


def _fmt_status(d: dict) -> str:
    lines = [f"sync: {_fmt_ts(d.get('last_sync'))}"]
    for p in d["pools"]:
        flag = "BLOCKED(" + p["blocked_by"] + ")" if p["blocked_by"] else "ok"
        lines.append(
            f"\n[{p['account']}/{p['pool']}] {flag}  used {p['used_eur']:.2f} / {p['initial_eur']:.2f} EUR "
            f"({p['used_eur'] / p['initial_eur'] * 100:.1f} %)  reset in {p['days_left']:.1f} d"
        )
        lines.append(f"   fair share/day: {p['daily_fair_share_eur']:.3f} EUR   room now: {p['room_eur']:.3f} EUR"
                     + (f"   retry: {_fmt_ts(p['retry_at'])}" if p["retry_at"] else ""))
        m = p["month"]
        lines.append(f"   {'month':>6}  spent {m['spent']:8.3f}  cap {m['cap']:8.3f}  room {m['room']:8.3f}")
        for n, w in p["windows"].items():
            lines.append(f"   {n:>6}  spent {w['spent']:8.3f}  cap {w['cap']:8.3f}  room {w['room']:8.3f}"
                         + (f"  free again {_fmt_ts(w['retry_at'])}" if w["retry_at"] else ""))
    if d.get("by_client_7d"):
        lines.append("\nlast 7 days by client:")
        for r in d["by_client_7d"]:
            lines.append(f"   {r['client']:<14} {r['account']}/{r['pool']:<5} {r['n']:>5} req  {r['cost_eur']:.3f} EUR")
    return "\n".join(lines)


def _server_url(cfg):
    return f"http://{cfg.host}:{cfg.port}"


def cmd_status(a):
    from .budget import BudgetEngine

    cfg, db, store = open_app()
    eng = BudgetEngine(db, cfg.limits)
    d = {"last_sync": 0, "pools": [], "by_client_7d": db.by_client_since(time.time() - 7 * 86400)}
    for acc in cfg.accounts:
        for pool in ("vibe", "api"):
            s = eng.status(acc.name, pool)
            if s:
                d["pools"].append(s.to_dict())
    print(json.dumps(d, indent=2) if a.json else _fmt_status(d))
    return 0


def cmd_sync(a):
    from .sync import sync_all

    cfg, db, _ = open_app()

    async def run():
        async with httpx.AsyncClient() as http:
            return await sync_all(http, cfg, db)

    print(json.dumps(asyncio.run(run()), indent=2))
    return 0


def cmd_serve(a):
    import uvicorn

    from .proxy import create_app

    cfg = C.load()
    if a.port:
        cfg.port = a.port
    print(f"mistwatch: open http://{cfg.host}:{cfg.port}/ in your browser")
    uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port, log_level="info")
    return 0


def cmd_route(a):
    """Dry run of the `auto` router (no API call)."""
    from . import router

    prompt = " ".join(a.prompt) if a.prompt else sys.stdin.read()
    body = {"messages": [{"role": "user", "content": prompt}]}
    if a.tools:
        body["tools"] = [{"type": "function"}]
    llm = None
    if a.llm:
        from . import classifier

        cfg, _, _ = open_app()
        acc = next(x for x in cfg.accounts if x.keys)
        pool = "api" if "api" in acc.keys else next(iter(acc.keys))

        async def go():
            async with httpx.AsyncClient() as http:
                return await classifier.rate(http, cfg.upstream, acc.key_for(pool), body,
                                             cfg.router.classifier_model, cfg.router.classifier_timeout_s)

        res = asyncio.run(go())
        llm = res[0] if res else None
        print(f"tiny LLM ({cfg.router.classifier_model}): {llm}")
    d = router.decide(body, a.model, a.pressure, llm)
    print(f"{d.model}  effort={d.effort}  level={d.level}/6  score={d.score}/10")
    print(f"  {d.reason}")
    return 0


def cmd_vibe_config(a):
    cfg = C.load()
    print(f"""Point Vibe CLI at the proxy: add to ~/.vibe/config.toml

[[providers]]
name = "mistwatch"
api_base = "{_server_url(cfg)}/v1"
api_key_env_var = "MISTWATCH_TOKEN"
backend = "mistral"

# then re-point your models' provider = "mistwatch" and set
#   MISTWATCH_TOKEN=<a key generated on the "API keys" page of the web UI>
Other tools: base URL {_server_url(cfg)}/v1, API key = that same key.""")
    return 0


def cmd_agent_config(a):
    """Print (or --write, merged into the existing file) a provider block for Pi or OpenCode."""
    from pathlib import Path

    cfg = C.load()
    env = a.env
    if a.tool == "pi":
        data, path = agents.pi(_server_url(cfg), env), Path.home() / ".pi" / "agent" / "models.json"
    else:
        data, path = agents.opencode(_server_url(cfg), env), Path.home() / ".config" / "opencode" / "opencode.json"
    if not a.write:
        print(f"# {path}\n{json.dumps(data, indent=2)}")
        print(f"\n# set {env}=<a key from the API keys page>; add --write to merge this into the file", file=sys.stderr)
        return 0
    cur = {}
    if path.exists():
        try:
            cur = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            print(f"{path} is not plain JSON (comments?); not touching it. Paste the block above manually.")
            return 1
        path.with_suffix(".json.bak").write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(agents.merge(cur, data), indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path} (backup: .json.bak). Set {env}=<key from the API keys page>.")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="mistwatch")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("init"); s.add_argument("--force", action="store_true")
    s.add_argument("--import-vibe", action="store_true", help="add the Vibe CLI keyring login as an account")
    s.set_defaults(f=cmd_init)
    s = sub.add_parser("import-vibe"); s.add_argument("--name", default="vibe-login"); s.set_defaults(f=cmd_import_vibe)
    s = sub.add_parser("status"); s.add_argument("--json", action="store_true"); s.set_defaults(f=cmd_status)
    sub.add_parser("sync").set_defaults(f=cmd_sync)
    s = sub.add_parser("serve"); s.add_argument("--port", type=int); s.set_defaults(f=cmd_serve)
    s = sub.add_parser("route", help="dry-run the auto router on a prompt")
    s.add_argument("prompt", nargs="*"); s.add_argument("--model", default="auto"); s.add_argument("--tools", action="store_true"); s.add_argument("--llm", action="store_true", help="also ask the tiny LLM (~0.00003 EUR)")
    s.add_argument("--pressure", type=float, default=1.0, help="free budget fraction 0-1")
    s.set_defaults(f=cmd_route)
    s = sub.add_parser("passwd", help="create a user / reset a password"); s.add_argument("username"); s.set_defaults(f=cmd_passwd)
    sub.add_parser("vibe-config").set_defaults(f=cmd_vibe_config)
    s = sub.add_parser("agent-config", help="provider config for Pi or OpenCode")
    s.add_argument("tool", choices=["pi", "opencode"]); s.add_argument("--write", action="store_true")
    s.add_argument("--env", default="MISTWATCH_TOKEN", help="env var holding the proxy key")
    s.set_defaults(f=cmd_agent_config)
    a = ap.parse_args(argv)
    return a.f(a)


if __name__ == "__main__":
    sys.exit(main())
