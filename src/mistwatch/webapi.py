"""JSON API behind the web UI (/api/*). Authenticated with a session cookie created at login."""
from __future__ import annotations

import time
from importlib import resources

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse

from .groups import summarize
from .usage import DIMENSIONS, RANGES, usage
from .signin import SignInError
from .store import Store, StoreError, VIBE_REF, vibe_cli_key_present
from .sync import check_key, sync_all

COOKIE = "mw_session"
MAX_FAILS, LOCK_SECONDS = 5, 60


def status_payload(st) -> dict:
    now = time.time()
    pools = []
    for a in st.cfg.accounts:
        for pool in ("vibe", "api"):
            s = st.engine.status(a.name, pool, now)
            if s:
                d = s.to_dict()
                d["blocked_temporarily"] = st.blocked_until.get((a.name, pool), 0) > now
                d["enabled"] = a.enabled
                pools.append(d)
    return {"now": now, "last_sync": st.last_sync, "pools": pools,
            "summary": summarize(st.engine, st.cfg.accounts, now),
            "by_client_7d": st.db.by_client_since(now - 7 * 86400)}


def register(app: FastAPI) -> None:
    api = APIRouter(prefix="/api")
    fails: dict[str, tuple[int, float]] = {}

    def st_of(request: Request):
        return request.app.state.mw

    def store_of(request: Request) -> Store:
        return request.app.state.mw.store

    def user(request: Request) -> dict:
        u = store_of(request).get_session(request.cookies.get(COOKIE))
        if not u:
            raise HTTPException(401, "You are not signed in.")
        if request.method not in ("GET", "HEAD") and request.headers.get("x-mw") != "1":
            raise HTTPException(403, "Missing x-mw header (CSRF protection).")
        return u

    def set_cookie(resp: Response, token: str) -> None:
        resp.set_cookie(COOKIE, token, httponly=True, samesite="strict", max_age=30 * 86400, path="/")

    def guard(fn):
        """Turn StoreError into a 400 with a readable message."""
        try:
            return fn()
        except StoreError as e:
            raise HTTPException(400, str(e)) from e

    def need_json(request: Request) -> None:
        if request.method != "GET" and request.headers.get("x-mw") != "1":
            raise HTTPException(403, "Missing x-mw header (CSRF protection).")

    # ---------- session ----------
    @api.get("/session")
    async def session(request: Request):
        store = store_of(request)
        u = store.get_session(request.cookies.get(COOKIE))
        return {"setup_needed": store.count_users() == 0, "user": u}

    @api.post("/setup")
    async def setup(request: Request, response: Response):
        need_json(request)
        store = store_of(request)
        if store.count_users() > 0:
            raise HTTPException(409, "An account already exists, please sign in.")
        b = await request.json()
        uid = guard(lambda: store.create_user(str(b.get("username", "")), str(b.get("password", ""))))
        set_cookie(response, store.create_session(uid))
        out: dict = {"ok": True}
        if not store.has_api_keys():  # a fresh install should not leave the proxy open to every local process
            row, secret = store.create_api_key("default")
            out["api_key"] = {"name": row["name"], "secret": secret}
        return out

    @api.post("/login")
    async def login(request: Request, response: Response):
        need_json(request)
        store = store_of(request)
        b = await request.json()
        name = str(b.get("username", ""))
        key = f"{request.client.host if request.client else '?'}|{name.lower()}"
        n, until = fails.get(key, (0, 0))
        if until > time.time():
            raise HTTPException(429, f"Too many attempts, try again in {int(until - time.time())} s.")
        u = store.verify_login(name, str(b.get("password", ""))[:256])
        if not u:
            n += 1
            fails[key] = (n, time.time() + LOCK_SECONDS if n >= MAX_FAILS else 0)
            if n >= MAX_FAILS:
                fails[key] = (0, time.time() + LOCK_SECONDS)
            raise HTTPException(401, "Wrong username or password.")
        fails.pop(key, None)
        set_cookie(response, store.create_session(u["id"]))
        return {"ok": True, "user": u}

    @api.post("/logout")
    async def logout(request: Request, response: Response):
        need_json(request)
        store_of(request).delete_session(request.cookies.get(COOKIE))
        response.delete_cookie(COOKIE, path="/")
        return {"ok": True}

    @api.post("/password")
    async def password(request: Request, u: dict = Depends(user)):
        store = store_of(request)
        b = await request.json()
        if not store.check_user_password(u["id"], str(b.get("old", ""))[:256]):
            raise HTTPException(400, "Current password is incorrect.")
        guard(lambda: store.set_password(u["id"], str(b.get("new", ""))))
        store.delete_other_sessions(u["id"], request.cookies.get(COOKIE))
        return {"ok": True}

    # ---------- users ----------
    @api.get("/users")
    async def users(request: Request, u: dict = Depends(user)):
        return store_of(request).list_users()

    @api.post("/users")
    async def add_user(request: Request, u: dict = Depends(user)):
        b = await request.json()
        guard(lambda: store_of(request).create_user(str(b.get("username", "")), str(b.get("password", ""))))
        return {"ok": True}

    @api.delete("/users/{user_id}")
    async def del_user(user_id: int, request: Request, u: dict = Depends(user)):
        if user_id == u["id"]:
            raise HTTPException(400, "You cannot delete yourself.")
        guard(lambda: store_of(request).delete_user(user_id))
        return {"ok": True}

    # ---------- dashboard ----------
    @api.get("/status")
    async def status(request: Request, u: dict = Depends(user)):
        return status_payload(st_of(request))

    @api.get("/summary")
    async def summary(request: Request, u: dict = Depends(user)):
        st = st_of(request)
        return {"last_sync": st.last_sync, **summarize(st.engine, st.cfg.accounts)}

    @api.get("/usage")
    async def usage_series(request: Request, range: str = "7d", by: str = "model", u: dict = Depends(user)):
        if range not in RANGES or by not in DIMENSIONS:
            raise HTTPException(400, "Unknown range or grouping.")
        st = st_of(request)
        return usage(st.db, range, by, time.time(), st.names)

    @api.get("/ledger")
    async def ledger(request: Request, limit: int = 40, u: dict = Depends(user)):
        st = st_of(request)
        rows = st.db.recent(max(1, min(limit, 500)))
        for r in rows:
            r["model_name"] = st.names.display(r["model"]) if r.get("model") else None
        return rows

    # ---------- model names ----------
    @api.get("/models")
    async def models(request: Request, all: bool = False, u: dict = Depends(user)):
        return st_of(request).names.listing(include_all=all)

    @api.put("/models/{key:path}")
    async def rename_model(key: str, request: Request, u: dict = Depends(user)):
        b = await request.json()
        try:
            st_of(request).names.set_override(key, str(b.get("display", "")))
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        return {"ok": True}

    @api.delete("/models/{key:path}")
    async def reset_model(key: str, request: Request, u: dict = Depends(user)):
        st_of(request).names.clear_override(key)
        return {"ok": True}

    @api.post("/models-refresh")
    async def refresh_models(request: Request, u: dict = Depends(user)):
        st = st_of(request)
        for a in st.cfg.accounts:
            for pool in a.keys:
                try:
                    return {"models": await st.names.refresh(st.http, st.cfg.upstream, a.key_for(pool))}
                except Exception:  # noqa: BLE001
                    continue
        raise HTTPException(502, "Could not load the model list from Mistral (is a key configured?).")

    @api.post("/sync")
    async def sync(request: Request, u: dict = Depends(user)):
        st = st_of(request)
        res = await sync_all(st.http, st.cfg, st.db)
        st.last_sync = time.time()
        st.blocked_until.clear()
        return res

    # ---------- Mistral accounts and keys ----------
    def acct_view(st, a) -> dict:
        return {"name": a.name, "priority": a.priority, "enabled": a.enabled, "keys": st.store.key_info(a),
                "shared_with": [m for m in st.db.members(a.name) if m != a.name]}

    @api.get("/accounts")
    async def accounts(request: Request, u: dict = Depends(user)):
        st = st_of(request)
        return {"accounts": [acct_view(st, a) for a in st.store.list_accounts()],
                "vibe_cli_available": vibe_cli_key_present()}

    @api.post("/accounts")
    async def add_account(request: Request, u: dict = Depends(user)):
        st = st_of(request)
        b = await request.json()
        guard(lambda: st.store.create_account(str(b.get("name", "")), int(b.get("priority", 100))))
        st.reload_accounts()
        return {"ok": True}

    def get_acct(st, name: str):
        a = st.store.get_account(name)
        if not a:
            raise HTTPException(404, "Account does not exist.")
        return a

    @api.patch("/accounts/{name}")
    async def patch_account(name: str, request: Request, u: dict = Depends(user)):
        st = st_of(request)
        get_acct(st, name)
        b = await request.json()
        st.store.update_account(name, enabled=b.get("enabled"), priority=b.get("priority"))
        st.reload_accounts()
        return {"ok": True}

    @api.delete("/accounts/{name}")
    async def del_account(name: str, request: Request, u: dict = Depends(user)):
        st = st_of(request)
        get_acct(st, name)
        st.store.delete_account(name)
        st.reload_accounts()
        return {"ok": True}

    @api.post("/keys/check")
    async def check(request: Request, u: dict = Depends(user)):
        st = st_of(request)
        b = await request.json()
        key = str(b.get("key", "")).strip()
        if not key:
            raise HTTPException(400, "Key is missing.")
        return await check_key(st.http, st.cfg.upstream, key)

    @api.put("/accounts/{name}/keys/{pool}")
    async def put_key(name: str, pool: str, request: Request, u: dict = Depends(user)):
        """Body: {"key": "..."} to store a pasted key, or {"source": "vibe-cli"} to follow the Vibe CLI login."""
        st = st_of(request)
        a = get_acct(st, name)
        b = await request.json()
        if b.get("source") == "vibe-cli":
            if not vibe_cli_key_present():
                raise HTTPException(400, "No Vibe CLI sign-in in the keyring (run `vibe --setup`).")
            guard(lambda: st.store.set_key(name, pool, ref=VIBE_REF))
        else:
            key = str(b.get("key", "")).strip()
            if b.get("verify", True):
                chk = await check_key(st.http, st.cfg.upstream, key)
                if not chk["valid"]:
                    raise HTTPException(400, chk["error"])
            guard(lambda: st.store.set_key(name, pool, value=key))
        st.reload_accounts()
        st.blocked_until.clear()
        a = get_acct(st, name)
        synced = (await sync_all(st.http, st.cfg, st.db)).get(name, {})  # full pass: also re-detects shared budgets
        st.last_sync = time.time()
        return {"ok": True, "synced": synced, "account": acct_view(st, a)}

    @api.delete("/accounts/{name}/keys/{pool}")
    async def del_key(name: str, pool: str, request: Request, u: dict = Depends(user)):
        st = st_of(request)
        get_acct(st, name)
        st.store.remove_key(name, pool)
        st.reload_accounts()
        return {"ok": True}

    # ---------- sign in through Mistral (browser flow, like `vibe --setup`) ----------
    @api.post("/accounts/{name}/signin")
    async def start_signin(name: str, request: Request, u: dict = Depends(user)):
        st = st_of(request)
        get_acct(st, name)
        try:
            a = await st.signin.start(name, "vibe")  # the key this flow creates is the Vibe-login key
        except SignInError as e:
            raise HTTPException(400, str(e)) from e
        return a.public()

    @api.get("/signin/{attempt_id}")
    async def signin_status(attempt_id: str, request: Request, u: dict = Depends(user)):
        a = st_of(request).signin.get(attempt_id)
        if not a:
            raise HTTPException(404, "Sign-in attempt does not exist.")
        return a.public()

    @api.delete("/signin/{attempt_id}")
    async def signin_cancel(attempt_id: str, request: Request, u: dict = Depends(user)):
        if not st_of(request).signin.cancel(attempt_id):
            raise HTTPException(404, "Sign-in attempt does not exist.")
        return {"ok": True}

    # ---------- proxy API keys ----------
    @api.get("/apikeys")
    async def apikeys(request: Request, u: dict = Depends(user)):
        st = st_of(request)
        return {"keys": st.store.list_api_keys(), "base_url": f"http://{st.cfg.host}:{st.cfg.port}/v1"}

    @api.post("/apikeys")
    async def new_apikey(request: Request, u: dict = Depends(user)):
        b = await request.json()
        row, secret = guard(lambda: store_of(request).create_api_key(str(b.get("name", ""))))
        return {"key": row, "secret": secret}  # the only time the full key is ever shown

    @api.delete("/apikeys/{key_id}")
    async def del_apikey(key_id: int, request: Request, u: dict = Depends(user)):
        if not store_of(request).delete_api_key(key_id):
            raise HTTPException(404, "Key does not exist.")
        return {"ok": True}

    app.include_router(api)

    # ---------- the UI itself ----------
    def page() -> HTMLResponse:
        html = resources.files("mistwatch").joinpath("web/index.html").read_text(encoding="utf-8")
        return HTMLResponse(html, headers={"Cache-Control": "no-store", "X-Frame-Options": "DENY",
                                           "Referrer-Policy": "no-referrer"})

    @app.get("/", response_class=HTMLResponse)
    async def index():
        return page()

    @app.get("/_dm/dashboard")
    async def old_dashboard():
        return RedirectResponse("/")
