import json
import httpx
import pytest
from fastapi.testclient import TestClient

from mistwatch.config import Account, Client, Config, Limits
from mistwatch.db import Snapshot
from mistwatch.proxy import create_app
import time


def make(tmp_path, monkeypatch):
    cfg = Config(db_path=tmp_path / "l.db", usd_to_eur=1.0,
                 accounts=[Account("a", {"vibe": "vibe-key", "api": "api-key"})], clients=[Client("t", "tok")])
    app = create_app(cfg)
    st = app.state.mw
    now = time.time()
    st.db.add_snapshot(Snapshot(now, "a", "api", 0.0, 12.75, now + 14 * 86400, "EUR"))
    st.db.add_snapshot(Snapshot(now, "a", "vibe", 127.5, 127.5, now + 14 * 86400, "EUR"))  # exhausted
    seen = {}

    def handler(request: httpx.Request):
        seen["auth"] = request.headers["authorization"]
        seen["ua"] = request.headers.get("user-agent")
        body = json.loads(request.content)
        if body.get("stream"):
            sse = ('data: {"model":"mistral-large-4-0","choices":[{"delta":{"content":"hi"}}]}\n\n'
                   'data: {"model":"mistral-large-4-0","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500}}\n\n'
                   'data: [DONE]\n\n')
            return httpx.Response(200, content=sse.encode(), headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json={"model": "mistral-large-4-0", "choices": [],
                                         "usage": {"prompt_tokens": 1000, "completion_tokens": 500}})
    return app, st, seen, httpx.MockTransport(handler)


def run(tmp_path, monkeypatch, fn):
    app, st, seen, transport = make(tmp_path, monkeypatch)
    with TestClient(app) as c:
        st.http = httpx.AsyncClient(transport=transport)  # swap after lifespan created the real one
        return fn(c, st, seen)


def test_auth_required(tmp_path, monkeypatch):
    def fn(c, st, seen):
        r = c.post("/v1/chat/completions", json={"model": "x"})
        assert r.status_code == 401
    run(tmp_path, monkeypatch, fn)


def test_forward_books_cost_and_swaps_key(tmp_path, monkeypatch):
    def fn(c, st, seen):
        r = c.post("/v1/chat/completions", json={"model": "mistral-large-4-0", "messages": []},
                   headers={"Authorization": "Bearer tok", "User-Agent": "curl"})
        assert r.status_code == 200 and seen["auth"] == "Bearer api-key"  # api pool -> api key
        assert r.headers["x-mw-pool"] == "api"
        rows = st.db.recent()
        assert abs(rows[0]["cost_eur"] - (1000 * 0.7 + 500 * 2.1) / 1e6) < 1e-9
    run(tmp_path, monkeypatch, fn)


def test_stream_usage_booked(tmp_path, monkeypatch):
    def fn(c, st, seen):
        r = c.post("/v1/chat/completions", json={"model": "mistral-large-4-0", "stream": True},
                   headers={"Authorization": "Bearer tok"})
        assert r.status_code == 200 and "[DONE]" in r.text
        assert st.db.recent()[0]["prompt_tokens"] == 1000
    run(tmp_path, monkeypatch, fn)


def test_vibe_ua_falls_back_when_vibe_pool_exhausted(tmp_path, monkeypatch):
    def fn(c, st, seen):
        r = c.post("/v1/chat/completions", json={"model": "mistral-large-4-0"},
                   headers={"Authorization": "Bearer tok", "User-Agent": "Mistral-Vibe/3.1.0"})
        assert r.status_code == 200 and r.headers["x-mw-pool"] == "api"
        assert seen["ua"] == "Mistral-Vibe/3.1.0"  # client identity passes through untouched
    run(tmp_path, monkeypatch, fn)


def test_429_when_everything_exhausted(tmp_path, monkeypatch):
    def fn(c, st, seen):
        now = time.time()
        st.db.add_snapshot(Snapshot(now + 1, "a", "api", 12.75, 12.75, now + 14 * 86400, "EUR"))
        r = c.post("/v1/chat/completions", json={"model": "m"}, headers={"Authorization": "Bearer tok"})
        assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
        assert r.json()["error"]["type"] == "mistwatch_budget_exhausted"
    run(tmp_path, monkeypatch, fn)
