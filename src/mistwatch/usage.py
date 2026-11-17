"""Usage over time for the dashboard charts: spend per hour/day, split by model, key, account or pool."""
from __future__ import annotations

import bisect
from datetime import datetime, timedelta

from .db import DB
from .modelnames import ModelNames

# range -> (number of buckets, bucket unit)
RANGES = {"24h": (24, "hour"), "7d": (7, "day"), "30d": (30, "day")}
DIMENSIONS = ("model", "client", "account", "pool")
TOP_N = 6
OTHER = "other"


def bucket_starts(now: float, n: int, unit: str) -> list[float]:
    """Local-time aligned bucket start timestamps, oldest first; the last bucket contains `now`."""
    cur = datetime.fromtimestamp(now)
    cur = cur.replace(minute=0, second=0, microsecond=0)
    step = timedelta(hours=1)
    if unit == "day":
        cur = cur.replace(hour=0)
        step = timedelta(days=1)
    out = []
    for i in range(n - 1, -1, -1):
        d = cur - i * step if unit == "hour" else (cur.replace(hour=0) - timedelta(days=i))
        out.append(d.timestamp())
    return out


def _label(row: dict, by: str, names: ModelNames) -> str:
    if by == "model":
        if not row["model"]:
            return "(external)" if row["source"] == "sync" else "(unknown)"
        return names.display(row["model"])  # aliases of one model share a display name, so they merge
    if by == "client":
        return row["client"] or "—"
    return row[by] or "—"


def usage(db: DB, range_: str, by: str, now: float, names: ModelNames | None = None) -> dict:
    if range_ not in RANGES:
        raise ValueError("unknown range")
    if by not in DIMENSIONS:
        raise ValueError("unknown grouping")
    names = names or ModelNames(db)
    n, unit = RANGES[range_]
    starts = bucket_starts(now, n, unit)
    since = starts[0]
    span = (starts[-1] - starts[0]) + (3600 if unit == "hour" else 86400)
    rows = db.usage_rows(since, now + 1)
    prev = db.usage_rows(since - span, since)

    totals: dict[str, float] = {}
    per: dict[str, list[float]] = {}
    for r in rows:
        i = bisect.bisect_right(starts, r["ts"]) - 1
        if i < 0:
            continue
        name = _label(r, by, names)
        per.setdefault(name, [0.0] * n)[i] += r["cost_eur"]
        totals[name] = totals.get(name, 0.0) + r["cost_eur"]
    ranked = sorted(totals, key=lambda k: -totals[k])
    keep, rest = ranked[:TOP_N], ranked[TOP_N:]
    series = [{"name": k, "total": totals[k], "values": per[k]} for k in keep]
    if rest:
        vals = [sum(per[k][i] for k in rest) for i in range(n)]
        series.append({"name": OTHER, "total": sum(totals[k] for k in rest), "values": vals})
    return {
        "range": range_, "by": by, "unit": unit, "buckets": starts,
        "step": 3600 if unit == "hour" else 86400,
        "series": series,
        "total": sum(r["cost_eur"] for r in rows),
        "prev_total": sum(r["cost_eur"] for r in prev),
        "requests": sum(1 for r in rows if r["source"] == "proxy" and r["client"] != "(router)"),
    }
