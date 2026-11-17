import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from mistwatch.config import Config
from mistwatch.proxy import create_app
from mistwatch.signin import pkce_pair

H = {"x-mw": "1"}


def make_handler(state):
    def handler(request: httpx.Request):
        url, path = str(request.url), request.url.path
        if url == "https://console.mistral.ai/api/vibe/sign-in":
            body = json.loads(request.content)
            state["challenge"] = body["code_challenge"]
            assert body["code_challenge_method"] == "S256"
            return httpx.Response(200, json={
                "process_id": "p1", "sign_in_url": state.get("sign_in_url", "https://console.mistral.ai/vibe/sign-in/p1"),
                "poll_url": "https://console.mistral.ai/api/vibe/sign-in/p1/poll",
                "expires_at": state.get("expires", "2099-01-01T00:00:00Z")})
        if path.endswith("/poll"):
            state["polls"] = state.get("polls", 0) + 1
            if state["polls"] < 3:
                return httpx.Response(200, json={"status": "pending"})
            return httpx.Response(200, json=state.get("final", {"status": "completed", "exchange_token": "xt"}))
        if path.endswith("/exchange"):
            body = json.loads(request.content)
            assert body["exchange_token"] == "xt"
            import base64, hashlib  # the verifier must match the challenge we sent first
            digest = base64.urlsafe_b64encode(hashlib.sha256(body["code_verifier"].encode()).digest()).decode().rstrip("=")
            assert digest == state["challenge"]
            if state.get("exchange_status"):
                return httpx.Response(state["exchange_status"], json={"error_code": 9004})
            return httpx.Response(200, json={"api_key": "signed-in-key-123456"})
        if path == "/v1/billing/budget":
            return httpx.Response(200, json={"vibe_budget": {"usage_percentage": 20, "initial_budget": 100,
                                                            "reset_at": "2099-01-01T00:00:00Z", "currency": "EUR"}})
        return httpx.Response(404)
    return handler


@pytest.fixture
def env(tmp_path):
    state: dict = {}
    app = create_app(Config(db_path=tmp_path / "s.db"))
    with TestClient(app) as c:
        st = app.state.mw
        st.http = httpx.AsyncClient(transport=httpx.MockTransport(make_handler(state)))
        st.signin.poll_interval = 0.01
        c.post("/api/setup", json={"username": "daniel", "password": "correct horse battery"}, headers=H)
        c.post("/api/accounts", json={"name": "me@example.cz"}, headers=H)
        yield c, st, state


def wait(c, aid, want, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        s = c.get(f"/api/signin/{aid}").json()
        if s["status"] in want:
            return s
        time.sleep(0.02)
    raise AssertionError(f"timeout, last status {s['status']}")


def test_pkce_pair_matches():
    import base64, hashlib
    v, ch = pkce_pair()
    assert ch == base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).decode().rstrip("=")


def test_full_flow_stores_key_and_syncs(env):
    c, st, state = env
    a = c.post("/api/accounts/me%40example.cz/signin", headers=H).json()
    assert a["sign_in_url"].startswith("https://console.mistral.ai/") and a["status"] == "pending"
    s = wait(c, a["id"], {"done", "error"})
    assert s["status"] == "done", s
    assert s["synced"]["vibe"]["initial"] == 100.0
    acct = st.store.get_account("me@example.cz")
    assert acct.keys["vibe"] == "signed-in-key-123456"  # keyring disabled in tests -> stored inline
    assert "signed-in-key-123456" not in json.dumps(c.get("/api/signin/" + a["id"]).json())


def test_denied_and_expired_and_error_states(env):
    c, st, state = env
    for final, want in [({"status": "denied"}, "denied"), ({"status": "expired"}, "expired"),
                        ({"status": "error", "message": "boom"}, "error")]:
        state.clear(); state["final"] = final
        a = c.post("/api/accounts/me%40example.cz/signin", headers=H).json()
        s = wait(c, a["id"], {want})
        assert s["status"] == want
    assert st.store.get_account("me@example.cz").keys == {}


def test_workspace_not_allowed_message(env):
    c, st, state = env
    state["exchange_status"] = 403
    a = c.post("/api/accounts/me%40example.cz/signin", headers=H).json()
    s = wait(c, a["id"], {"error"})
    assert "workspace" in s["message"].lower()


def test_foreign_sign_in_url_is_rejected(env):
    c, st, state = env
    state["sign_in_url"] = "https://evil.example.com/steal"
    r = c.post("/api/accounts/me%40example.cz/signin", headers=H)
    assert r.status_code == 400
    state["sign_in_url"] = "http://console.mistral.ai/vibe/sign-in/p1"  # plain http
    assert c.post("/api/accounts/me%40example.cz/signin", headers=H).status_code == 400


def test_cancel_and_auth(env):
    c, st, state = env
    state["final"] = {"status": "pending"}
    a = c.post("/api/accounts/me%40example.cz/signin", headers=H).json()
    assert c.delete(f"/api/signin/{a['id']}", headers=H).status_code == 200
    assert c.get(f"/api/signin/{a['id']}").json()["status"] == "cancelled"
    assert c.post("/api/accounts/nope/signin", headers=H).status_code == 404
    c.post("/api/logout", headers=H)
    assert c.post("/api/accounts/me%40example.cz/signin", headers=H).status_code == 401
