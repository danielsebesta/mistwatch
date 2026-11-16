"""Pacing engine.

For every (account, pool) we know, from Mistral's own counter (/v1/billing/budget):
  initial   - monthly allowance in EUR
  used      - consumed so far (snapshot) + proxy-observed spend after the snapshot
  reset_at  - when the counter resets

Fair-pace limit for a rolling window of length L days (5h, 1d, 7d):

    B0   = min(R + spent_L, initial)          # what was left when the window opened
    cap  = B0 * L / (D + L) * burst           # D = days until reset
    room = cap - spent_L

Because R and D are re-read all the time, unspent budget automatically raises the
limits ("half the month gone, nothing spent -> limits roughly double"), and
overspending lowers them. The monthly limit is simply the remaining budget minus
a reserve; it is a hard cap.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from .config import Limits
from .db import DB

DAY = 86400.0
WINDOWS = {"5h": 5 / 24, "day": 1.0, "week": 7.0}
MIN_DAYS_LEFT = 1 / 24


@dataclass
class WindowStatus:
    name: str
    length_days: float
    cap: float
    spent: float
    room: float
    retry_at: float | None = None


@dataclass
class PoolStatus:
    account: str
    pool: str
    initial: float
    used: float
    remaining: float
    reserve: float
    reset_at: float
    days_left: float
    snapshot_age_s: float
    windows: dict[str, WindowStatus] = field(default_factory=dict)
    month_room: float = 0.0
    month_retry_at: float | None = None
    inflight: float = 0.0

    @property
    def room(self) -> float:
        rooms = [self.month_room] + [w.room for w in self.windows.values()]
        return min(rooms) - self.inflight

    @property
    def pressure(self) -> float:
        """Fraction of the tightest window/month still free (1 = plenty, 0 = nothing)."""
        fr = [max(w.room, 0) / w.cap for w in self.windows.values() if w.cap > 0]
        month_cap = self.initial - self.reserve
        if month_cap > 0:
            fr.append(max(self.month_room, 0) / month_cap)
        return min(fr) if fr else 1.0

    @property
    def blocked_by(self) -> str | None:
        if self.room > 0:
            return None
        if self.month_room - self.inflight <= 0:
            return "month"
        worst = min(self.windows.values(), key=lambda w: w.room)
        return worst.name

    @property
    def retry_at(self) -> float | None:
        b = self.blocked_by
        if b is None:
            return None
        return self.month_retry_at if b == "month" else self.windows[b].retry_at

    def to_dict(self) -> dict:
        return {
            "account": self.account, "pool": self.pool,
            "initial_eur": round(self.initial, 4), "used_eur": round(self.used, 4),
            "remaining_eur": round(self.remaining, 4), "reserve_eur": round(self.reserve, 4),
            "reset_at": self.reset_at, "days_left": round(self.days_left, 3),
            "snapshot_age_s": round(self.snapshot_age_s, 1),
            "daily_fair_share_eur": round(max(self.remaining - self.reserve, 0) / self.days_left, 4),
            "room_eur": round(self.room, 4), "blocked_by": self.blocked_by, "retry_at": self.retry_at,
            "month": {"cap": round(self.initial - self.reserve, 4), "spent": round(self.used, 4),
                      "room": round(self.month_room, 4)},
            "windows": {
                n: {"cap": round(w.cap, 4), "spent": round(w.spent, 4), "room": round(w.room, 4),
                    "retry_at": w.retry_at}
                for n, w in self.windows.items()
            },
        }


class BudgetEngine:
    def __init__(self, db: DB, limits: Limits):
        self.db = db
        self.limits = limits
        self.inflight: dict[tuple[str, str], float] = {}

    def burst(self, name: str) -> float:
        return {"5h": self.limits.burst_5h, "day": self.limits.burst_day, "week": self.limits.burst_week}[name]

    def status(self, account: str, pool: str, now: float | None = None) -> PoolStatus | None:
        now = now or time.time()
        snap = self.db.latest_snapshot(account, pool)
        if snap is None:
            return None
        initial = snap.initial_eur
        rolled = now >= snap.reset_at
        if rolled:
            # Period rolled over but we have no fresh snapshot yet: assume a clean counter
            # and count only what the proxy saw since the reset.
            used = self.db.cost_between(account, pool, snap.reset_at, inclusive=True)
            days_left = 30.0
        else:
            used = snap.used_eur + self.db.cost_between(account, pool, snap.ts)
            days_left = max((snap.reset_at - now) / DAY, MIN_DAYS_LEFT)
        remaining = initial - used
        reserve = initial * self.limits.reserve_pct / 100
        st = PoolStatus(account, pool, initial, used, remaining, reserve, snap.reset_at, days_left,
                        now - snap.ts, inflight=self.inflight.get((account, pool), 0.0))
        st.month_room = remaining - reserve
        st.month_retry_at = snap.reset_at if st.month_room <= 0 else None
        for name, length in WINDOWS.items():
            since = now - length * DAY
            rows = self.db.rows_since(account, pool, since)
            spent = sum(c for _, c in rows)
            b0 = min(max(remaining, 0.0) + spent, initial)
            share = length / (days_left + length)
            k = share * self.burst(name)
            cap = b0 * k
            room = cap - spent
            ws = WindowStatus(name, length, cap, spent, room)
            if room <= 0 and rows:
                ws.retry_at = self._window_retry(rows, length, max(remaining, 0.0), k)
            st.windows[name] = ws
        return st

    @staticmethod
    def _window_retry(rows: list[tuple[float, float]], length: float, remaining: float, k: float) -> float | None:
        """Earliest time the window's headroom turns positive as old spend rolls off.

        room = R*k - s*(1-k); positive when s < R*k/(1-k).  (k >= 1 never binds.)"""
        if k >= 1:
            return None
        target = remaining * k / (1 - k)
        s = sum(c for _, c in rows)
        for ts, cost in rows:
            s -= cost
            if s < target:
                return ts + length * DAY + 1
        return rows[-1][0] + length * DAY + 1

    def reserve(self, account: str, pool: str, est: float) -> None:
        k = (account, pool)
        self.inflight[k] = self.inflight.get(k, 0.0) + est

    def release(self, account: str, pool: str, est: float) -> None:
        k = (account, pool)
        self.inflight[k] = max(self.inflight.get(k, 0.0) - est, 0.0)
