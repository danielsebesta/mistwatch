"""Reads Mistral's own budget counters and reconciles them with the local ledger."""
from __future__ import annotations

import calendar
import logging
import time
from datetime import datetime, timezone

import httpx

from .config import Account, Config
from .db import DB, Snapshot

log = logging.getLogger("dast_mistral.sync")
POOLS = {"vibe_budget": "vibe", "api_budget": "api"}
USER_AGENT = "dast-mistral/0.1"


def parse_iso(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def next_reset(reset_day: int, now: float) -> float:
    d = datetime.fromtimestamp(now, timezone.utc)
    y, m = d.year, d.month
    cand = datetime(y, m, min(reset_day, calendar.monthrange(y, m)[1]), tzinfo=timezone.utc)
    if cand.timestamp() <= now:
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        cand = datetime(y, m, min(reset_day, calendar.monthrange(y, m)[1]), tzinfo=timezone.utc)
    return cand.timestamp()


async def fetch_budget(client: httpx.AsyncClient, cfg: Config, acct: Account) -> dict:
    r = await client.get(
        f"{cfg.upstream}/v1/billing/budget",
        headers={"Authorization": f"Bearer {acct.any_key()}", "User-Agent": USER_AGENT},
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def record_snapshot(db: DB, account: str, pool: str, used: float, initial: float, reset_at: float,
                    currency: str | None, now: float) -> None:
    prev = db.latest_snapshot(account, pool)
    if prev and abs(prev.reset_at - reset_at) < 1 and now > prev.ts:
        # Same period: whatever Mistral counted beyond what the proxy saw came from elsewhere
        # (Vibe CLI used directly, web, other tools) or from price-table drift. Book the gap
        # so rolling windows account for it too.
        delta = used - prev.used_eur
        seen = db.cost_between(account, pool, prev.ts, now)
        gap = delta - seen
        if gap > 0.0005:
            db.add_ledger(ts=now, account=account, pool=pool, client="(external)", model=None,
                          endpoint="sync", cost_eur=gap, source="sync", estimated=1)
    db.add_snapshot(Snapshot(now, account, pool, used, initial, reset_at, currency))


async def sync_account(client: httpx.AsyncClient, cfg: Config, db: DB, acct: Account) -> dict:
    now = time.time()
    out: dict = {}
    try:
        data = await fetch_budget(client, cfg, acct)
    except Exception as e:  # noqa: BLE001
        log.warning("budget sync failed for %s: %s", acct.name, e)
        data = None
    if data:
        for field_name, pool in POOLS.items():
            b = data.get(field_name)
            if not b:
                continue
            initial = float(b["initial_budget"])
            used = float(b["usage_percentage"]) / 100 * initial
            reset_at = parse_iso(b["reset_at"]) if b.get("reset_at") else next_reset(1, now)
            record_snapshot(db, acct.name, pool, used, initial, reset_at, b.get("currency"), now)
            out[pool] = {"used": used, "initial": initial, "source": "mistral"}
    else:
        for pool, m in acct.manual.items():
            initial = float(m["initial_eur"])
            reset_at = next_reset(int(m.get("reset_day", 1)), now)
            period_start = _prev_month(reset_at)
            used = db.cost_between(acct.name, pool, period_start, inclusive=True)
            db.add_snapshot(Snapshot(now, acct.name, pool, used, initial, reset_at, "EUR"))
            out[pool] = {"used": used, "initial": initial, "source": "manual"}
    return out


def _prev_month(ts: float) -> float:
    d = datetime.fromtimestamp(ts, timezone.utc)
    y, m = (d.year - 1, 12) if d.month == 1 else (d.year, d.month - 1)
    return datetime(y, m, min(d.day, calendar.monthrange(y, m)[1]), tzinfo=timezone.utc).timestamp()


async def sync_all(client: httpx.AsyncClient, cfg: Config, db: DB) -> dict:
    res = {}
    for a in cfg.accounts:
        if a.enabled:
            res[a.name] = await sync_account(client, cfg, db, a)
    return res
