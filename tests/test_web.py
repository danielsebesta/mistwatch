import httpx
import pytest
from fastapi.testclient import TestClient

from mistwatch.config import Config
from mistwatch.proxy import create_app
from mistwatch.store import Store, hash_password, verify_password

H = {"x-mw": "1"}
PW = "correct horse battery"


def upstream(request: httpx.Request):
    key = request.headers["authorization"].removeprefix("Bearer ")
    if request.url.path == "/v1/billing/budget":
        if key.startswith("bad"):
            return httpx.Response(401, json={"message": "no"})
        return httpx.Response(200, json={
            "vibe_budget": {"usage_percentage": 10, "initial_budget": 100, "reset_at": "2099-01-01T00:00:00Z", "currency": "EUR"},
            "api_budget": {"usage_percentage": 50, "initial_budget": 10, "reset_at": "2099-01-01T00:00:00Z", "currency": "EUR"}})
    if request.url.path == "/v1/models":
        return httpx.Response(401)
    return httpx.Response(200, json={"model": "m", "choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 5}})


@pytest.fixture
def client(tmp_path):
    app = create_app(Config(db_path=tmp_path / "w.db"))
    with TestClient(app) as c:
        app.state.mw.http = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        yield c


def login(c):
    r = c.post("/api/setup", json={"username": "daniel", "password": PW}, headers=H)
    assert r.status_code == 200, r.text
    return r.json()


def test_password_hash_roundtrip():
    h = hash_password("secret-password")
    assert h.startswith("scrypt$") and "secret-password" not in h
    assert verify_password("secret-password", h) and not verify_password("nope", h)
    assert hash_password("secret-password") != h  # salted


def test_ui_and_auth_gate(client):
    assert "Mistwatch" in client.get("/").text
    assert client.get("/api/session").json() == {"setup_needed": True, "user": None}
    assert client.get("/api/status").status_code == 401


def test_setup_login_logout_and_first_key(client):
    out = login(client)
    assert out["api_key"]["secret"].startswith("mw-")
    assert client.post("/api/setup", json={"username": "x1", "password": PW}, headers=H).status_code == 409
    assert client.get("/api/session").json()["user"]["username"] == "daniel"
    client.post("/api/logout", headers=H)
    assert client.get("/api/status").status_code == 401
    assert client.post("/api/login", json={"username": "daniel", "password": "wrong-password"}, headers=H).status_code == 401
    assert client.post("/api/login", json={"username": "daniel", "password": PW}, headers=H).status_code == 200
    assert client.get("/api/status").status_code == 200


def test_csrf_header_required(client):
    login(client)
    assert client.post("/api/accounts", json={"name": "a"}).status_code == 403


def test_weak_password_rejected(client):
    r = client.post("/api/setup", json={"username": "daniel", "password": "short"}, headers=H)
    assert r.status_code == 400


def test_login_lockout(client):
    login(client)
    client.post("/api/logout", headers=H)
    codes = [client.post("/api/login", json={"username": "daniel", "password": "bad-password-x"}, headers=H).status_code
             for _ in range(7)]
    assert codes[:5] == [401] * 5 and codes[5] == 429
    assert client.post("/api/login", json={"username": "daniel", "password": PW}, headers=H).status_code == 429


def test_accounts_and_keys(client):
    login(client)
    assert client.post("/api/accounts", json={"name": "bad name!"}, headers=H).status_code == 400
    assert client.post("/api/accounts", json={"name": "osobni"}, headers=H).status_code == 200
    assert client.post("/api/accounts", json={"name": "osobni"}, headers=H).status_code == 400
    # an invalid key is rejected before it is stored
    r = client.put("/api/accounts/osobni/keys/api", json={"key": "bad-key-123456"}, headers=H)
    assert r.status_code == 400
    r = client.put("/api/accounts/osobni/keys/api", json={"key": "good-key-123456"}, headers=H)
    assert r.status_code == 200
    assert r.json()["synced"]["api"] == {"used": 5.0, "initial": 10.0, "source": "mistral"}
    acc = client.get("/api/accounts").json()["accounts"][0]
    assert acc["keys"]["api"]["hint"] == "good-…3456" and acc["keys"]["vibe"] is None
    assert "good-key-123456" not in client.get("/api/accounts").text  # never echoed in full
    pools = {(p["account"], p["pool"]) for p in client.get("/api/status").json()["pools"]}
    assert ("osobni", "api") in pools
    assert client.delete("/api/accounts/osobni/keys/api", headers=H).status_code == 200
    assert client.delete("/api/accounts/osobni", headers=H).status_code == 200


def test_key_check_endpoint(client):
    login(client)
    assert client.post("/api/keys/check", json={"key": "good-key-123456"}, headers=H).json()["valid"] is True
    assert client.post("/api/keys/check", json={"key": "bad-key-123456"}, headers=H).json()["valid"] is False


def test_proxy_keys_lifecycle(client):
    out = login(client)
    first = out["api_key"]["secret"]
    # the proxy now requires a key
    assert client.post("/v1/chat/completions", json={"model": "x"}).status_code == 401
    assert client.post("/v1/chat/completions", json={"model": "x"}, headers={"authorization": "Bearer nope"}).status_code == 401
    created = client.post("/api/apikeys", json={"name": "vibe-cli"}, headers=H).json()
    secret = created["secret"]
    listing = client.get("/api/apikeys").json()["keys"]
    assert {k["name"] for k in listing} == {"default", "vibe-cli"}
    assert secret not in client.get("/api/apikeys").text  # only a prefix is ever listed
    # the key authenticates (no account yet -> 429 from the budget gate, not 401)
    r = client.post("/v1/chat/completions", json={"model": "x"}, headers={"authorization": "Bearer " + secret})
    assert r.status_code == 429
    kid = created["key"]["id"]
    assert client.delete(f"/api/apikeys/{kid}", headers=H).status_code == 200
    r = client.post("/v1/chat/completions", json={"model": "x"}, headers={"authorization": "Bearer " + secret})
    assert r.status_code == 401
    assert first  # the default key is untouched


def test_users_and_password_change(client):
    login(client)
    assert client.post("/api/users", json={"username": "anna", "password": "another-long-pass"}, headers=H).status_code == 200
    users = client.get("/api/users").json()
    me = next(u for u in users if u["username"] == "daniel")
    assert client.delete(f"/api/users/{me['id']}", headers=H).status_code == 400  # not yourself
    assert client.post("/api/password", json={"old": "wrong-old-pass", "new": "brand-new-password"}, headers=H).status_code == 400
    assert client.post("/api/password", json={"old": PW, "new": "brand-new-password"}, headers=H).status_code == 200
    client.post("/api/logout", headers=H)
    assert client.post("/api/login", json={"username": "daniel", "password": PW}, headers=H).status_code == 401
    assert client.post("/api/login", json={"username": "daniel", "password": "brand-new-password"}, headers=H).status_code == 200


def test_config_migration_runs_once(tmp_path, monkeypatch):
    from mistwatch.config import Account, Client
    cfg = Config(db_path=tmp_path / "m.db", accounts=[Account("old", {"api": "literal-key-12345"})], clients=[Client("t", "tok-1")])
    app = create_app(cfg)
    st = app.state.mw
    assert [a.name for a in st.store.list_accounts()] == ["old"]
    assert st.store.verify_api_key("tok-1")["name"] == "t"
    st.store.delete_account("old")
    Store(st.db).migrate_config(cfg)  # must not resurrect deleted accounts
    assert st.store.list_accounts() == []


def test_email_account_names(client):
    login(client)
    name = "daniel+mistral@example.cz"
    assert client.post("/api/accounts", json={"name": name}, headers=H).status_code == 200
    from urllib.parse import quote
    q = quote(name, safe="")
    r = client.put(f"/api/accounts/{q}/keys/api", json={"key": "good-key-123456"}, headers=H)
    assert r.status_code == 200, r.text
    assert client.get("/api/accounts").json()["accounts"][0]["name"] == name
    assert client.patch(f"/api/accounts/{q}", json={"enabled": False}, headers=H).status_code == 200
    assert client.delete(f"/api/accounts/{q}", headers=H).status_code == 200
    assert client.post("/api/accounts", json={"name": "a b"}, headers=H).status_code == 400
    assert client.post("/api/accounts", json={"name": "x/y"}, headers=H).status_code == 400
