import time

import httpx
import pytest
from fastapi.testclient import TestClient

from mistwatch.config import Config
from mistwatch.db import DB
from mistwatch.proxy import create_app
from mistwatch.usage import bucket_starts, usage

H = {"x-mw": "1"}
NOW = time.mktime((2026, 11, 17, 15, 30, 0, 0, 0, -1))


def add(db, ago_h, cost, model="m1", client="c1", account="a", pool="vibe", source="proxy"):
    db.add_ledger(ts=NOW - ago_h * 3600, account=account, pool=pool, client=client, model=model, endpoint="e",
                  cost_eur=cost, source=source)


def test_bucket_alignment():
    h = bucket_starts(NOW, 24, "hour")
    assert len(h) == 24 and h[-1] <= NOW < h[-1] + 3600 and h[1] - h[0] == 3600
    d = bucket_starts(NOW, 7, "day")
    assert len(d) == 7 and d[-1] <= NOW < d[-1] + 90000
    assert time.localtime(d[-1]).tm_hour == 0


def test_daily_series_split_by_model_and_previous_period():
    db = DB(":memory:")
    add(db, 1, 1.0, "m1")           # today
    add(db, 2, 0.5, "m2")           # today
    add(db, 30, 2.0, "m1")          # yesterday
    add(db, 24 * 9, 4.0, "m1")      # in the previous 7d window
    u = usage(db, "7d", "model", NOW)
    names = {s["name"]: s for s in u["series"]}
    assert names["M1"]["total"] == pytest.approx(3.0) and names["M2"]["total"] == pytest.approx(0.5)
    assert u["total"] == pytest.approx(3.5) and u["prev_total"] == pytest.approx(4.0)
    assert sum(sum(s["values"]) for s in u["series"]) == pytest.approx(3.5)
    assert u["series"][0]["name"] == "M1"  # biggest first
    assert len(u["buckets"]) == 7 and u["requests"] == 4 - 1  # the old row is outside the window


def test_hourly_and_top_n_merge():
    db = DB(":memory:")
    for i in range(9):
        add(db, 0.2, 1.0 + i, model=f"model-{i}")
    u = usage(db, "24h", "model", NOW)
    assert len(u["series"]) == 7 and u["series"][-1]["name"] == "other"  # top 6 + other
    assert u["series"][0]["name"] == "Model 8"
    assert u["unit"] == "hour" and len(u["buckets"]) == 24
    assert sum(s["total"] for s in u["series"]) == pytest.approx(u["total"])


def test_groupings_and_external_rows():
    db = DB(":memory:")
    add(db, 1, 1.0, client="vibe-cli", account="x", pool="vibe")
    add(db, 1, 0.3, client="(external)", model=None, account="x", pool="api", source="sync")
    add(db, 1, 0.0001, client="(router)", model="ministral-3b-latest", account="y", pool="vibe")
    assert {s["name"] for s in usage(db, "7d", "model", NOW)["series"]} == {"M1", "(external)", "Ministral 3 3B"}
    assert {s["name"] for s in usage(db, "7d", "pool", NOW)["series"]} == {"vibe", "api"}
    assert {s["name"] for s in usage(db, "7d", "client", NOW)["series"]} == {"vibe-cli", "(external)", "(router)"}
    assert usage(db, "7d", "account", NOW)["requests"] == 1  # external + router rows are not user requests
    with pytest.raises(ValueError):
        usage(db, "1y", "model", NOW)


def test_usage_endpoint_and_fair_daily(tmp_path):
    def handler(req):
        return httpx.Response(200, json={
            "vibe_budget": {"usage_percentage": 20, "initial_budget": 100, "reset_at": "2099-01-01T00:00:00Z", "currency": "EUR"},
            "api_budget": {"usage_percentage": 0, "initial_budget": 10, "reset_at": "2099-01-01T00:00:00Z", "currency": "EUR"}})
    app = create_app(Config(db_path=tmp_path / "u.db"))
    with TestClient(app) as c:
        st = app.state.mw
        st.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        assert c.get("/api/usage").status_code == 401
        c.post("/api/setup", json={"username": "daniel", "password": "correct horse battery"}, headers=H)
        c.post("/api/accounts", json={"name": "a"}, headers=H)
        c.put("/api/accounts/a/keys/vibe", json={"key": "key-12345678", "verify": False}, headers=H)
        st.db.add_ledger(ts=time.time() - 60, account="a", pool="vibe", client="vibe-cli", model="zai-glm-5-3",
                         endpoint="e", cost_eur=0.25, source="proxy")
        u = c.get("/api/usage?range=24h&by=client").json()
        assert u["total"] == pytest.approx(0.25) and u["series"][0]["name"] == "vibe-cli"
        assert c.get("/api/usage?range=bogus").status_code == 400
        sm = c.get("/api/summary").json()["all"]
        assert sm["fair_daily_eur"] > 0
