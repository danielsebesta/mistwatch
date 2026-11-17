import asyncio
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from mistwatch.budget import BudgetEngine
from mistwatch.config import Account, Config, Limits
from mistwatch.db import DB, Snapshot
from mistwatch.groups import refresh_links, summarize
from mistwatch.proxy import create_app
from mistwatch.sync import sync_all

NOW = 1_800_000_000.0
RESET = NOW + 15 * 86400


def snap(db, account, pool, used, initial, ts=NOW):
    db.add_snapshot(Snapshot(ts, account, pool, used, initial, RESET, "EUR"))


def seed(db, account, vibe_used=0.0, api_used=0.0, vibe=127.5, api=12.75, ts=NOW):
    snap(db, account, "vibe", vibe_used, vibe, ts)
    snap(db, account, "api", api_used, api, ts)


def accounts(*names):
    return [Account(n, {"vibe": "k"}, priority=i) for i, n in enumerate(names)]


def test_three_keys_same_account_are_one_budget():
    db = DB(":memory:")
    for n in "abc":
        seed(db, n, vibe_used=20.123456789, api_used=0.004123)  # identical counters, something spent
    accs = accounts("a", "b", "c")
    links = refresh_links(db, accs)
    assert links == {"b": "a", "c": "a"} and set(db.links_info.values()) == {"sure"}
    eng = BudgetEngine(db, Limits())
    s = summarize(eng, accs, NOW)
    assert s["pools"]["vibe"]["budgets"] == 1 and s["pools"]["vibe"]["initial_eur"] == pytest.approx(127.5)
    assert s["pools"]["vibe"]["accounts"] == ["a", "b", "c"]
    assert s["all"]["initial_eur"] == pytest.approx(127.5 + 12.75)  # not x3
    assert s["shared"] == [{"canonical": "a", "members": ["a", "b", "c"], "confidence": "sure"}]


def test_spend_through_any_member_counts_for_all():
    db = DB(":memory:")
    for n in "ab":
        seed(db, n, vibe_used=10.5)
    accs = accounts("a", "b")
    eng = BudgetEngine(db, Limits())
    before = {n: eng.status(n, "vibe", NOW + 60).windows["day"].room for n in "ab"}
    refresh_links(db, accs)
    db.add_ledger(ts=NOW + 30, account="b", pool="vibe", cost_eur=3.0, source="proxy")  # spent via key b
    sa, sb = eng.status("a", "vibe", NOW + 60), eng.status("b", "vibe", NOW + 60)
    assert sa.used == pytest.approx(13.5) and sb.used == pytest.approx(13.5)  # a sees b's spend
    assert sa.windows["day"].spent == pytest.approx(3.0) and sa.windows["day"].room < before["a"]
    assert sa.room == pytest.approx(sb.room)


def test_reservations_are_shared_too():
    db = DB(":memory:")
    for n in "ab":
        seed(db, n, vibe_used=1.0)
    refresh_links(db, accounts("a", "b"))
    eng = BudgetEngine(db, Limits())
    eng.reserve("b", "vibe", 0.5)
    assert eng.status("a", "vibe", NOW + 1).inflight == pytest.approx(0.5)


def test_zero_usage_is_merged_conservatively_then_splits_on_divergence():
    db = DB(":memory:")
    for n in "ab":
        seed(db, n)
    accs = accounts("a", "b")
    refresh_links(db, accs)
    assert db.links == {"b": "a"} and db.links_info == {"b": "likely"}
    # a spends, b's counter does not move -> they are different budgets after all
    later = NOW + 300
    seed(db, "a", vibe_used=2.0, ts=later)
    seed(db, "b", vibe_used=0.0, ts=later + 2)
    refresh_links(db, accs)
    assert db.links == {}


def test_different_budgets_are_summed():
    db = DB(":memory:")
    seed(db, "me", vibe_used=127.5, api_used=0.01)  # exhausted EDU
    seed(db, "school", vibe=255.0, api=25.5)
    accs = accounts("me", "school")
    assert refresh_links(db, accs) == {}
    s = summarize(BudgetEngine(db, Limits()), accs, NOW)
    assert s["pools"]["vibe"]["budgets"] == 2
    assert s["pools"]["vibe"]["initial_eur"] == pytest.approx(382.5)
    assert s["pools"]["vibe"]["remaining_eur"] == pytest.approx(255.0)  # exhausted budget adds nothing
    assert s["pools"]["vibe"]["room_eur"] > 0 and not s["pools"]["vibe"]["blocked"]  # the other one can serve
    assert s["all"]["initial_eur"] == pytest.approx(382.5 + 38.25)
    assert s["shared"] == []


def test_stale_account_keeps_its_link():
    db = DB(":memory:")
    for n in "ab":
        seed(db, n, vibe_used=5.5)
    accs = accounts("a", "b", "c")
    refresh_links(db, accs[:2])
    assert db.links == {"b": "a"}
    # b failed to sync this round (old snapshot); a and c are fresh and different from each other
    later = NOW + 1000
    seed(db, "a", vibe_used=6.5, ts=later)
    seed(db, "c", vibe_used=1.0, ts=later)
    refresh_links(db, accs)
    assert db.links == {"b": "a"}  # not dropped just because b could not be compared


def test_disabled_accounts_are_ignored():
    db = DB(":memory:")
    seed(db, "a", vibe_used=1.0)
    seed(db, "b", vibe_used=1.0)
    accs = accounts("a", "b")
    accs[1].enabled = False
    s = summarize(BudgetEngine(db, Limits()), accs, NOW)
    assert s["pools"]["vibe"]["accounts"] == ["a"]


# ---- end to end through sync: the same Mistral org behind three keys ----
def test_sync_books_external_spend_once_for_shared_budget(tmp_path):
    state = {"used": 10.0}

    def handler(req: httpx.Request):
        return httpx.Response(200, json={
            "vibe_budget": {"usage_percentage": state["used"], "initial_budget": 100, "reset_at": "2099-01-01T00:00:00Z", "currency": "EUR"},
            "api_budget": {"usage_percentage": 5.5, "initial_budget": 10, "reset_at": "2099-01-01T00:00:00Z", "currency": "EUR"}})

    cfg = Config(db_path=tmp_path / "x.db", accounts=[Account(n, {"vibe": "k-" + n}, priority=i) for i, n in enumerate("abc")])
    db = DB(cfg.db_path)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            await sync_all(http, cfg, db)
            state["used"] = 12.0  # 2 EUR spent outside the proxy, visible through every key
            await sync_all(http, cfg, db)

    asyncio.run(run())
    assert db.links == {"b": "a", "c": "a"}
    external = db.conn.execute("SELECT account, SUM(cost_eur) FROM ledger WHERE source='sync' AND pool='vibe' GROUP BY 1").fetchall()
    assert [(r[0], round(r[1], 6)) for r in external] == [("a", 2.0)]  # booked once, not three times
    s = BudgetEngine(db, Limits()).status("b", "vibe")
    assert s.used == pytest.approx(12.0)


def test_summary_endpoint_dedupes(tmp_path):
    def handler(req: httpx.Request):
        return httpx.Response(200, json={
            "vibe_budget": {"usage_percentage": 20, "initial_budget": 100, "reset_at": "2099-01-01T00:00:00Z", "currency": "EUR"},
            "api_budget": {"usage_percentage": 50, "initial_budget": 10, "reset_at": "2099-01-01T00:00:00Z", "currency": "EUR"}})

    app = create_app(Config(db_path=tmp_path / "e.db"))
    H = {"x-mw": "1"}
    with TestClient(app) as c:
        st = app.state.mw
        st.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        c.post("/api/setup", json={"username": "daniel", "password": "correct horse battery"}, headers=H)
        for n in ("one@example.cz", "two@example.cz", "three@example.cz"):
            c.post("/api/accounts", json={"name": n}, headers=H)
            assert c.put(f"/api/accounts/{n.replace('@', '%40')}/keys/vibe", json={"key": "key-" + n, "verify": False}, headers=H).status_code == 200
        d = c.get("/api/summary").json()
        assert d["pools"]["vibe"]["budgets"] == 1 and d["pools"]["vibe"]["initial_eur"] == 100.0
        assert d["pools"]["vibe"]["used_eur"] == pytest.approx(20.0)
        assert d["all"]["initial_eur"] == pytest.approx(110.0)
        assert len(d["shared"]) == 1 and len(d["shared"][0]["members"]) == 3
        full = c.get("/api/status").json()
        assert full["summary"]["all"]["initial_eur"] == pytest.approx(110.0)
        assert all(p["group"] == "one@example.cz" for p in full["pools"])
