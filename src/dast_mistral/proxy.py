"""The proxy: authenticates local clients, picks an (account, pool) with headroom, forwards, books cost."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from importlib import resources

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse

from .budget import BudgetEngine, PoolStatus
from .config import Account, Client, Config
from .db import DB
from . import classifier, router
from .pricing import PriceBook
from .sync import sync_all

log = logging.getLogger("dast_mistral.proxy")

HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
       "transfer-encoding", "upgrade", "host", "content-length", "content-encoding"}
ACCOUNTED = ("/v1/chat/completions", "/v1/fim/completions", "/v1/agents/completions",
             "/v1/embeddings", "/v1/ocr", "/v1/conversations", "/v1/moderations")


class State:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.db = DB(cfg.db_path)
        self.engine = BudgetEngine(self.db, cfg.limits)
        self.prices = PriceBook(cfg.usd_to_eur, cfg.price_overrides)
        self.vibe_re = re.compile(cfg.limits.vibe_user_agent_regex, re.I)
        self.blocked_until: dict[tuple[str, str], float] = {}
        self.http: httpx.AsyncClient | None = None
        self.last_sync: float = 0
        self.accounts = {a.name: a for a in cfg.accounts}

    def classify(self, ua: str) -> str:
        return "vibe" if self.vibe_re.search(ua or "") else "api"

    def candidates(self, cls: str) -> list[tuple[Account, str, PoolStatus]]:
        now = time.time()
        order = [cls] + (["api" if cls == "vibe" else "vibe"] if self.cfg.limits.fallback_to_other_pool else [])
        out = []
        for a in self.cfg.accounts:
            if not a.enabled:
                continue
            for rank, pool in enumerate(order):
                if pool not in a.keys:
                    continue
                if self.blocked_until.get((a.name, pool), 0) > now:
                    continue
                st = self.engine.status(a.name, pool, now)
                if st is None or st.room <= 0:
                    continue
                out.append((rank, a, pool, st))
        if self.cfg.limits.strategy == "priority":
            out.sort(key=lambda t: (t[0], t[1].priority, -t[3].room))
        else:
            out.sort(key=lambda t: (t[0], -t[3].room, t[1].priority))
        return [(a, p, s) for _, a, p, s in out]

    def exhausted_info(self, cls: str) -> dict:
        now = time.time()
        pools, retry = [], []
        for a in self.cfg.accounts:
            for pool in ("vibe", "api"):
                st = self.engine.status(a.name, pool, now)
                if st is None:
                    continue
                pools.append({"account": a.name, "pool": pool, "blocked_by": st.blocked_by or "temporarily-blocked",
                              "retry_at": st.retry_at})
                if st.retry_at:
                    retry.append(st.retry_at)
        return {"pools": pools, "retry_after": max(int(min(retry) - now), 1) if retry else 60}


def _extract_usage(obj: dict) -> tuple[int, int, int] | None:
    u = obj.get("usage")
    if isinstance(u, dict) and ("prompt_tokens" in u or "completion_tokens" in u):
        det = u.get("prompt_tokens_details") or {}
        cached = int(u.get("num_cached_tokens") or det.get("cached_tokens") or 0)
        return int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0), cached
    return None


def _estimate_tokens(chars: int) -> int:
    return max(chars // 4, 1)


def create_app(cfg: Config) -> FastAPI:
    st = State(cfg)

    async def sync_loop():
        while True:
            try:
                await sync_all(st.http, cfg, st.db)
                st.last_sync = time.time()
                st.blocked_until.clear()
            except Exception:  # noqa: BLE001
                log.exception("sync loop")
            await asyncio.sleep(cfg.limits.sync_interval_s)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        st.http = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=15), follow_redirects=False)
        task = asyncio.create_task(sync_loop())
        try:
            yield
        finally:
            task.cancel()
            await st.http.aclose()

    app = FastAPI(title="dast-mistral", lifespan=lifespan)
    app.state.dm = st

    def auth(request: Request) -> Client | None | bool:
        """Returns Client, or None when auth is disabled, or False when rejected."""
        if not cfg.clients:
            return None
        tok = request.headers.get("authorization", "")
        tok = tok[7:] if tok.lower().startswith("bearer ") else request.headers.get("x-api-key", "") or request.query_params.get("token", "")
        for c in cfg.clients:
            if tok and tok == c.token:
                return c
        return False

    def deny():
        return JSONResponse({"error": {"message": "invalid proxy token", "type": "dast_mistral_auth"}}, status_code=401)

    # ---------- local management API ----------
    @app.get("/_dm/status")
    async def status(request: Request):
        if auth(request) is False:
            return deny()
        now = time.time()
        pools = []
        for a in cfg.accounts:
            for pool in ("vibe", "api"):
                s = st.engine.status(a.name, pool, now)
                if s:
                    d = s.to_dict()
                    d["blocked_temporarily"] = st.blocked_until.get((a.name, pool), 0) > now
                    pools.append(d)
        return {"now": now, "last_sync": st.last_sync, "pools": pools,
                "by_client_7d": st.db.by_client_since(now - 7 * 86400)}

    @app.get("/_dm/ledger")
    async def ledger(request: Request, limit: int = 50):
        if auth(request) is False:
            return deny()
        return st.db.recent(min(limit, 500))

    @app.post("/_dm/sync")
    async def force_sync(request: Request):
        if auth(request) is False:
            return deny()
        res = await sync_all(st.http, cfg, st.db)
        st.last_sync = time.time()
        st.blocked_until.clear()
        return res

    @app.get("/_dm/dashboard", response_class=HTMLResponse)
    async def dashboard():
        return resources.files("dast_mistral").joinpath("dashboard.html").read_text(encoding="utf-8")

    # ---------- the proxy ----------
    @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def forward(path: str, request: Request):
        client = auth(request)
        if client is False:
            return deny()
        url_path = "/" + path
        body = await request.body()
        ua = request.headers.get("user-agent", "")
        cls = st.classify(ua)
        accounted = url_path.startswith(ACCOUNTED) and request.method == "POST"

        parsed: dict = {}
        if body and "json" in request.headers.get("content-type", ""):
            try:
                parsed = json.loads(body)
            except ValueError:
                parsed = {}
        model = parsed.get("model")
        want_stream = bool(parsed.get("stream"))

        if accounted:
            cands = st.candidates(cls)
        else:  # model lists, files, etc.: no cost accounting, any enabled account will do
            cands = [(a, next(iter(a.keys), cls), None) for a in cfg.accounts if a.enabled and a.keys][:1]
        if not cands:
            info = st.exhausted_info(cls)
            return JSONResponse(
                {"error": {"type": "dast_mistral_budget_exhausted",
                           "message": "No account/pool has budget headroom right now.", **info}},
                status_code=429, headers={"Retry-After": str(info["retry_after"])})

        routed = None
        if model in router.AUTO_MODELS and url_path == "/v1/chat/completions" and parsed:
            acct0, pool0, pst0 = cands[0]
            llm = None
            if cfg.router.llm_classifier:
                h = router.score_request(parsed)[0]
                key0 = acct0.key_for(pool0)
                if router.worth_asking(parsed, h) and key0:
                    res = await classifier.rate(st.http, cfg.upstream, key0, parsed,
                                                cfg.router.classifier_model, cfg.router.classifier_timeout_s)
                    if res:
                        llm, pt, ct = res
                        if pt or ct:  # not a cache hit: the rating call itself costs a little, book it
                            c, _ = st.prices.cost_eur(cfg.router.classifier_model, pt, ct)
                            st.db.add_ledger(ts=time.time(), account=acct0.name, pool=pool0, client='(router)',
                                             model=cfg.router.classifier_model, endpoint='router',
                                             prompt_tokens=pt, completion_tokens=ct, cost_eur=c,
                                             source='proxy', status=200)
            routed = router.decide(parsed, model, pst0.pressure if pst0 else 1.0, llm)
            parsed = router.apply(parsed, routed)
            body = json.dumps(parsed).encode()
            model = routed.model
            log.info("auto -> %s | %s", routed.header(), routed.reason)

        # rough pre-flight estimate, only used to hold headroom for concurrent requests
        price, _ = st.prices.lookup(model)
        est_in = _estimate_tokens(len(body))
        est_out = int(parsed.get("max_tokens") or 1024)
        est = (est_in * price.input + est_out * price.output) / 1e6 * cfg.usd_to_eur

        fwd_headers = {k: v for k, v in request.headers.items()
                       if k.lower() not in HOP and k.lower() not in ("authorization", "x-api-key", "accept-encoding")}
        t0 = time.time()
        last_resp: tuple[int, bytes, str] | None = None
        for acct, pool, pst in cands:
            try:
                key = acct.key_for(pool)
            except Exception as e:  # noqa: BLE001
                log.error("cannot resolve key for %s: %s", acct.name, e)
                continue
            if not key:
                continue
            h = dict(fwd_headers)
            h["Authorization"] = f"Bearer {key}"
            req = st.http.build_request(request.method, cfg.upstream + url_path, headers=h,
                                        params=request.query_params, content=body or None)
            try:
                resp = await st.http.send(req, stream=True)
            except httpx.HTTPError as e:
                log.warning("upstream error via %s: %s", acct.name, e)
                continue
            if resp.status_code in (401, 402, 403, 429) and accounted:
                text = await resp.aread()
                log.warning("upstream %s via %s/%s: %s", resp.status_code, acct.name, pool, text[:300])
                st.blocked_until[(acct.name, pool)] = time.time() + (30 if resp.status_code == 429 else 600)
                last_resp = (resp.status_code, text, resp.headers.get("content-type", "application/json"))
                continue

            hdrs = {k: v for k, v in resp.headers.items() if k.lower() not in HOP}
            hdrs.update({"x-dm-account": acct.name, "x-dm-pool": pool})
            if routed:
                hdrs["x-dm-routed"] = routed.header()
            if pst is not None:
                hdrs["x-dm-room-eur"] = f"{pst.room:.4f}"
            if not accounted:
                return StreamingResponse(resp.aiter_bytes(), status_code=resp.status_code, headers=hdrs,
                                         background=_closer(resp))
            st.engine.reserve(acct.name, pool, est)
            ctx = dict(acct=acct.name, pool=pool, client=client.name if client else None, model=model,
                       endpoint=url_path, est=est, est_in=est_in, t0=t0, stream=want_stream)
            if want_stream and resp.status_code == 200:
                return StreamingResponse(_tee_stream(st, resp, ctx), status_code=200, headers=hdrs)
            content = await resp.aread()
            await resp.aclose()
            _book_json(st, resp.status_code, content, ctx)
            return Response(content, status_code=resp.status_code, headers=hdrs)

        if last_resp is not None:  # every candidate refused: surface the last upstream answer
            return Response(last_resp[1], status_code=last_resp[0], headers={"content-type": last_resp[2]})
        return JSONResponse({"error": {"type": "dast_mistral_upstream", "message": "all upstream attempts failed"}},
                            status_code=502)

    return app


def _closer(resp: httpx.Response):
    from starlette.background import BackgroundTask
    return BackgroundTask(resp.aclose)


def _book(st: State, ctx: dict, usage: tuple[int, int, int] | None, status: int, est_flag: bool,
          pages: int | None = None, model: str | None = None) -> None:
    st.engine.release(ctx["acct"], ctx["pool"], ctx["est"])
    model = model or ctx["model"]
    if pages is not None:
        cost, exact, p, c, cached = st.prices.pages_cost_eur(pages), True, pages, 0, 0
    elif usage is not None:
        p, c, cached = usage
        cost, exact = st.prices.cost_eur(model, p, c, cached)
    else:
        return
    st.db.add_ledger(ts=time.time(), account=ctx["acct"], pool=ctx["pool"], client=ctx["client"], model=model,
                     endpoint=ctx["endpoint"], prompt_tokens=p, completion_tokens=c, cached_tokens=cached,
                     cost_eur=cost, source="proxy", estimated=int(est_flag or not exact), status=status,
                     latency_ms=int((time.time() - ctx["t0"]) * 1000))


def _book_json(st: State, status: int, content: bytes, ctx: dict) -> None:
    if status >= 400:
        st.engine.release(ctx["acct"], ctx["pool"], ctx["est"])
        return
    try:
        obj = json.loads(content)
    except ValueError:
        st.engine.release(ctx["acct"], ctx["pool"], ctx["est"])
        return
    pages = (obj.get("usage_info") or {}).get("pages_processed") if isinstance(obj, dict) else None
    usage = _extract_usage(obj) if isinstance(obj, dict) else None
    _book(st, ctx, usage, status, False, pages=pages, model=(obj.get("model") if isinstance(obj, dict) else None))


async def _tee_stream(st: State, resp: httpx.Response, ctx: dict):
    usage = None
    model = None
    out_chars = 0
    buf = b""
    try:
        async for chunk in resp.aiter_bytes():
            yield chunk
            buf += chunk
            *lines, buf = buf.split(b"\n")
            for line in lines:
                line = line.strip()
                if not line.startswith(b"data:") or line.endswith(b"[DONE]"):
                    continue
                try:
                    obj = json.loads(line[5:])
                except ValueError:
                    continue
                model = obj.get("model") or model
                usage = _extract_usage(obj) or usage
                for ch in obj.get("choices", []):
                    d = ch.get("delta", {}).get("content")
                    if isinstance(d, str):
                        out_chars += len(d)
                    elif isinstance(d, list):
                        out_chars += sum(len(x.get("text", "")) for x in d if isinstance(x, dict))
    finally:  # also runs on client disconnect: partial generations still cost money
        await resp.aclose()
        estimated = usage is None
        if usage is None:
            usage = (ctx["est_in"], _estimate_tokens(out_chars), 0)
        _book(st, ctx, usage, 200, estimated, model=model)
