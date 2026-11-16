"""dast-mistral command line."""
from __future__ import annotations

import argparse
import asyncio
import json
import secrets
import sys
import time
from datetime import datetime

import httpx

from . import config as C

TEMPLATE = """\
# dast-mistral config. Secrets are never stored here: use keyring:/env: references.
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

{accounts}
[[clients]]
name = "default"
token = "{token}"
"""

ACCOUNT_VIBE = """\
[[accounts]]
name = "vibe-login"
priority = 1
[accounts.keys]
vibe = "keyring:ai.mistral.vibe/MISTRAL_API_KEY"   # Vibe CLI login key (Windows Credential Manager)
# api = "env:MISTRAL_API_KEY"   # console.mistral.ai API key of the same org -> unlocks the separate API budget
"""


def cmd_init(a):
    p = C.config_path()
    if p.exists() and not a.force:
        print(f"{p} already exists (use --force)")
        return 1
    p.parent.mkdir(parents=True, exist_ok=True)
    acc = ""
    if a.import_vibe:
        acc = ACCOUNT_VIBE
    p.write_text(TEMPLATE.format(accounts=acc, token="dm-" + secrets.token_urlsafe(24)), encoding="utf-8")
    print(f"wrote {p}")
    return 0


def cmd_import_vibe(a):
    """Add the Vibe CLI login as an account (as a keyring reference - the key is not copied)."""
    import keyring

    if not keyring.get_password("ai.mistral.vibe", "MISTRAL_API_KEY"):
        print("No Vibe CLI key found in the OS keyring (run `vibe --setup` first).")
        return 1
    p = C.config_path()
    txt = p.read_text(encoding="utf-8")
    if 'name = "%s"' % a.name in txt:
        print("account name already present")
        return 1
    block = ACCOUNT_VIBE.replace("vibe-login", a.name)
    marker = "[[clients]]"
    txt = txt.replace(marker, block + "\n" + marker, 1) if marker in txt else txt + "\n" + block
    p.write_text(txt, encoding="utf-8")
    print(f"added account {a.name!r} -> keyring ai.mistral.vibe/MISTRAL_API_KEY")
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
    cfg = C.load()
    tok = cfg.clients[0].token if cfg.clients else ""
    try:
        r = httpx.get(_server_url(cfg) + "/_dm/status", headers={"Authorization": f"Bearer {tok}"}, timeout=5)
        r.raise_for_status()
        d = r.json()
    except httpx.HTTPError:  # server not running: compute from the DB directly
        from .budget import BudgetEngine
        from .db import DB

        db = DB(cfg.db_path)
        eng = BudgetEngine(db, cfg.limits)
        d = {"last_sync": 0, "pools": [], "by_client_7d": db.by_client_since(time.time() - 7 * 86400)}
        for acc in cfg.accounts:
            for pool in ("vibe", "api"):
                s = eng.status(acc.name, pool)
                if s:
                    d["pools"].append(s.to_dict())
        print("(server not running - values from last snapshot + ledger)")
    print(json.dumps(d, indent=2) if a.json else _fmt_status(d))
    return 0


def cmd_sync(a):
    from .db import DB
    from .sync import sync_all

    cfg = C.load()

    async def run():
        async with httpx.AsyncClient() as http:
            return await sync_all(http, cfg, DB(cfg.db_path))

    print(json.dumps(asyncio.run(run()), indent=2))
    return 0


def cmd_serve(a):
    import uvicorn

    from .proxy import create_app

    cfg = C.load()
    if a.port:
        cfg.port = a.port
    print(f"dast-mistral on http://{cfg.host}:{cfg.port}  dashboard: /_dm/dashboard"
          + (f"?token={cfg.clients[0].token}" if cfg.clients else ""))
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

        cfg = C.load()
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
name = "dast-proxy"
api_base = "{_server_url(cfg)}/v1"
api_key_env_var = "DAST_MISTRAL_TOKEN"
backend = "mistral"

# then re-point your models' provider = "dast-proxy" and set
#   DAST_MISTRAL_TOKEN={cfg.clients[0].token if cfg.clients else '<token>'}
Other tools: base URL {_server_url(cfg)}/v1, API key = the client token above.""")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="dast-mistral")
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
    sub.add_parser("vibe-config").set_defaults(f=cmd_vibe_config)
    a = ap.parse_args(argv)
    return a.f(a)


if __name__ == "__main__":
    sys.exit(main())
