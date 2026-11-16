import time
from dast_mistral.budget import BudgetEngine, DAY
from dast_mistral.config import Limits
from dast_mistral.db import DB, Snapshot
from dast_mistral.pricing import PriceBook


def mk(initial=127.5, used=0.0, days_left=30.0, **lim):
    db = DB(":memory:")
    now = time.time()
    db.add_snapshot(Snapshot(now, "a", "vibe", used, initial, now + days_left * DAY, "EUR"))
    return db, BudgetEngine(db, Limits(**lim)), now


def test_fair_share_even_pace():
    db, eng, now = mk()
    s = eng.status("a", "vibe", now)
    assert abs(s.windows["day"].cap - 127.5 / 31 * 1.5) < 0.05
    assert s.room > 0 and s.blocked_by is None


def test_unspent_budget_raises_limits_over_time():
    _, e1, n1 = mk(used=0, days_left=30)
    _, e2, n2 = mk(used=0, days_left=15)  # half the month gone, nothing spent
    assert e2.status("a", "vibe", n2).windows["day"].cap > 1.8 * e1.status("a", "vibe", n1).windows["day"].cap


def test_window_blocks_then_frees():
    db, eng, now = mk()
    cap = eng.status("a", "vibe", now).windows["5h"].cap
    db.add_ledger(ts=now - 60, account="a", pool="vibe", cost_eur=cap + 1, source="proxy")
    s = eng.status("a", "vibe", now)
    assert s.blocked_by == "5h"
    assert now < s.retry_at <= now + 5 / 24 * DAY + 5
    assert eng.status("a", "vibe", now + 5 / 24 * DAY + 10).windows["5h"].room > 0


def test_monthly_hard_cap_and_exhausted_pool():
    db, eng, now = mk(used=127.5)
    s = eng.status("a", "vibe", now)
    assert s.blocked_by == "month" and s.retry_at == s.reset_at


def test_reserve_blocks_before_zero():
    db, eng, now = mk(used=127.5 * 0.98, reserve_pct=3.0)
    assert eng.status("a", "vibe", now).month_room < 0


def test_inflight_reduces_room():
    db, eng, now = mk()
    before = eng.status("a", "vibe", now).room
    eng.reserve("a", "vibe", 1.0)
    assert abs(before - eng.status("a", "vibe", now).room - 1.0) < 1e-9


def test_pricing():
    pb = PriceBook(1.0)
    c, exact = pb.cost_eur("mistral-large-4-0", 1_000_000, 1_000_000)
    assert exact and abs(c - 2.8) < 1e-9
    c, exact = pb.cost_eur("mistral-vibe-cli-latest", 1000, 1000)
    assert exact
    _, exact = pb.cost_eur("something-new", 10, 10)
    assert not exact
