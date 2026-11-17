"""Detects accounts/keys that draw on the *same* Mistral budget, and totals limits across all independent budgets.

Mistral exposes no organisation id, so identity is inferred from the counters themselves. `/v1/billing/budget`
returns the org-wide budget whichever key asks, hence two keys of one org return the same numbers (initial budget,
used %, reset time) down to many decimals. Counters that are identical *in the same sync pass* mean one shared budget:

* "sure":   something has been spent, so the identical used-% is practically impossible by chance;
* "likely": nothing spent anywhere yet, so identical counters could also be two fresh, equal plans. They are merged
            conservatively (never inflate limits) and split automatically as soon as the counters diverge.

Links are recomputed after every full sync, so adding a duplicate key neither doubles the limits nor requires any
manual step, and a mistaken merge heals itself.
"""
from __future__ import annotations

import json
import time

from .budget import WINDOWS, BudgetEngine
from .config import Account
from .db import DB, Snapshot

POOLS = ("vibe", "api")
SAME_PASS_S = 90.0  # snapshots further apart than this were not taken in one sync pass and are not comparable
EPS_EUR = 1e-6


def load_links(db: DB) -> None:
    raw = db.get_meta("links")
    db.links, db.links_info = {}, {}
    if raw:
        try:
            data = json.loads(raw)
            db.links = {k: v["canonical"] for k, v in data.items()}
            db.links_info = {k: v["confidence"] for k, v in data.items()}
        except (ValueError, KeyError, TypeError):
            pass


def _same(a: dict[str, Snapshot], b: dict[str, Snapshot]) -> bool:
    if set(a) != set(b) or not a:
        return False
    for pool, x in a.items():
        y = b[pool]
        if abs(x.initial_eur - y.initial_eur) > EPS_EUR or abs(x.reset_at - y.reset_at) > 1 \
                or abs(x.used_eur - y.used_eur) > EPS_EUR:
            return False
    return True


def refresh_links(db: DB, accounts: list[Account]) -> dict[str, str]:
    """Recomputes which accounts share a budget. Only compares snapshots from the same sync pass."""
    snaps: dict[str, dict[str, Snapshot]] = {}
    for a in accounts:
        per = {p: s for p in POOLS if (s := db.latest_snapshot(a.name, p)) is not None}
        if per:
            snaps[a.name] = per
    if not snaps:
        return db.links
    newest = max(s.ts for per in snaps.values() for s in per.values())
    fresh = {n: per for n, per in snaps.items() if min(s.ts for s in per.values()) >= newest - SAME_PASS_S}
    stale = set(snaps) - set(fresh)

    # union-find over the fresh accounts
    names = sorted(fresh)
    parent = {n: n for n in names}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, x in enumerate(names):
        for y in names[i + 1:]:
            if _same(fresh[x], fresh[y]):
                parent[find(y)] = find(x)
    clusters: dict[str, list[str]] = {}
    for n in names:
        clusters.setdefault(find(n), []).append(n)

    prio = {a.name: (a.priority, a.name) for a in accounts}
    links: dict[str, str] = {}
    info: dict[str, str] = {}
    # keep what we know about accounts we could not compare this time (e.g. their sync failed)
    for m, c in db.links.items():
        if m in stale or c in stale:
            links[m], info[m] = c, db.links_info.get(m, "likely")
    for members in clusters.values():
        if len(members) < 2:
            continue
        canon = min(members, key=lambda n: prio.get(n, (999, n)))
        spent = any(s.used_eur > EPS_EUR for s in fresh[canon].values())
        for m in members:
            if m != canon:
                links[m], info[m] = canon, "sure" if spent else "likely"
    db.links, db.links_info = links, info
    db.set_meta("links", json.dumps({m: {"canonical": c, "confidence": info[m]} for m, c in links.items()}))
    return links


def shared_groups(db: DB) -> list[dict]:
    out: dict[str, dict] = {}
    for m, c in db.links.items():
        g = out.setdefault(c, {"canonical": c, "members": [c], "confidence": "sure"})
        g["members"].append(m)
        if db.links_info.get(m) != "sure":
            g["confidence"] = "likely"
    return [{**g, "members": sorted(g["members"])} for g in out.values()]


def _agg(statuses: list) -> dict:
    """Sums independent budgets (one PoolStatus per shared group)."""
    pos = lambda x: max(x, 0.0)  # noqa: E731 - an overdrawn budget contributes zero room, never negative room
    out = {
        "budgets": len(statuses),
        "accounts": sorted({m for s in statuses for m in s.members}),
        "initial_eur": sum(s.initial for s in statuses),
        "used_eur": sum(s.used for s in statuses),
        "remaining_eur": sum(pos(s.remaining) for s in statuses),
        "month": {"cap": sum(s.initial - s.reserve for s in statuses), "spent": sum(s.used for s in statuses),
                  "room": sum(pos(s.month_room) for s in statuses)},
        "room_eur": sum(pos(s.room) for s in statuses),
        # what an even spread of the usable budget over the days left would allow per day
        "fair_daily_eur": sum(pos(s.remaining - s.reserve) / s.days_left for s in statuses),
        "windows": {},
    }
    for n in WINDOWS:
        ws = [s.windows[n] for s in statuses]
        out["windows"][n] = {"cap": sum(w.cap for w in ws), "spent": sum(w.spent for w in ws),
                             "room": sum(pos(w.room) for w in ws)}
    blocked = [s for s in statuses if s.room <= 0]
    out["blocked"] = bool(statuses) and len(blocked) == len(statuses)
    retries = [s.retry_at for s in blocked if s.retry_at]
    out["retry_at"] = min(retries) if out["blocked"] and retries else None
    out["reset_at"] = min((s.reset_at for s in statuses), default=None)
    return out


def summarize(engine: BudgetEngine, accounts: list[Account], now: float | None = None) -> dict:
    """Totals across every account and key, counting each shared budget once."""
    now = now or time.time()
    seen: set[tuple[str, str]] = set()
    by_pool: dict[str, list] = {p: [] for p in POOLS}
    for a in accounts:
        if not a.enabled:
            continue
        for pool in POOLS:
            s = engine.status(a.name, pool, now)
            if s is None or (s.group, pool) in seen:
                continue
            seen.add((s.group, pool))
            by_pool[pool].append(s)
    pools = {p: _agg(v) for p, v in by_pool.items() if v}
    return {"pools": pools, "all": _agg([s for v in by_pool.values() for s in v]) if seen else None,
            "shared": shared_groups(engine.db), "accounts": len([a for a in accounts if a.enabled])}
