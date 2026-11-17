# Hardening notes (temporary hand-off)

Findings from auditing `src/mistwatch/*.py`, then the contract for the proxy + web API ports.
Modules provided: `src/errors.ts`, `src/queue.ts`, `src/ratelimit.ts`, `src/security.ts`.

## Findings in the Python original

Severity: **H** high, **M** medium, **L** low.

- **H** `proxy.py:150` — catch-all `/{path:path}` has no Host/Origin validation; when `has_api_keys()` is false the proxy is fully open, so any web page can drive it via DNS rebinding (and reach `/api/setup`'s first-user creation before the owner does).
- **H** `proxy.py:211-212` — `Cookie` (and `x-mw`) are not stripped: the `mw_session` cookie is forwarded to api.mistral.ai on every request, leaking the session token upstream.
- **H** `store.py:52-60` + `webapi.py:91-127` — scrypt runs synchronously on the event loop (~0.3-1 s at N=2^15,r=8) in login/password paths; a few concurrent requests stall the whole process, streams included.
- **H** `proxy.py:171,248` — budget race: `room` is checked in `candidates()` but `engine.reserve()` only runs after the upstream responds; N concurrent requests all see headroom and overspend.
- **H** `webapi.py:39` — the login lockout dict `fails` is unbounded (key `ip|username`, never GC'd): memory DoS via username spraying; no decay either, so stale failures never expire.
- **H** `proxy.py:156` — `await request.body()` has no size limit: an unbounded POST body is buffered in memory.
- **M** `proxy.py:229-231` — any `httpx.HTTPError` retries on the next account, including read timeouts after the request was already sent: the same chat request can be billed twice.
- **M** `proxy.py` — no global or per-key concurrency cap or request rate limit: a client flood opens unbounded upstream sockets/streams; one key can starve the others.
- **M** `proxy.py:253-255,288-296` — `engine.release()` is not in `finally`: an exception in `resp.aread()`/`_book_json` (e.g. a `ValueError` from `_extract_usage` at `proxy.py:100`) leaks the in-flight reservation, pinning the pool as "no headroom" until restart.
- **M** `proxy.py:239` — upstream `set-cookie` is forwarded to the client, letting Mistral set cookies on the proxy origin.
- **M** `webapi.py` — no rate limiting except the login lockout: `/api/sync`, `/api/models-refresh`, `/api/keys/check` hit upstream on every click.
- **M** `proxy.py:150` — the catch-all also forwards unknown `/api/*` paths to Mistral instead of 404ing.
- **M** `proxy.py:124` — single upstream timeout of 600 s; a wedged stream holds resources for 10 min; no connect/read split per request.
- **L** `proxy.py:159` — `url_path.startswith(ACCOUNTED)` matches prefixes like `/v1/ocr-anything` (missing path-segment boundary).
- **L** `proxy.py:234` — upstream error bodies are logged raw (`text[:300]`); should pass through redaction.
- **L** `webapi.py:48-53` — `sessions.last_seen` never updated and no idle expiry; expired rows only cleaned at next `create_session`.
- **L** `store.py:176-180` — `delete_user` commits sessions and users in two separate transactions (non-atomic); same pattern elsewhere.
- **L** `db.py` — relies on sqlite's default busy timeout; keep WAL + an explicit busy timeout in the port.
- **L** `webapi.py` — unvalidated JSON bodies (`b.get`, `int(...)`) produce 500s instead of 400s.
- **L** `cli.py:182` — shutdown relies on uvicorn; in-flight streams are cut and the last ledger writes are not explicitly drained.
- **L** `signin.py` — acceptable: `_check_url` pins scheme+origin+path, attempts are capped at 5 and expiry-bounded; keep the same checks.
- **L** `store.py:56` — cookie is `httponly` + `samesite=strict` (good); `secure` omitted because the UI is plain http on localhost (keep, but set it if ever served over https).

## Requirements for proxy and web API

Use the modules below; do not re-implement.

**Every request (both routers):** call `localRequestAllowed({host, origin}, {port})` first; reject with `errors.forbidden("forbidden host")` → `apiErrorBody`/`proxyErrorBody`. This is the DNS-rebinding fix.

- Cookie routes additionally require `x-mw: 1` on non-GET (existing rule — keep).
- Web API responses: `{detail}` via `apiErrorBody(e)`; proxy routes: `{error:{type,message,...}}` via `proxyErrorBody(e)`; always merge `errorHeaders(e)` for `Retry-After`.

**Rate limiting (`ratelimit.ts`):** one `createRateLimiter` per route class — global (`key=""`), per proxy key (`key=<key id>`), per client address on `/api/*` (`key=<ip>`). On `check(...).allowed === false` → `errors.rateLimited(retryAfter)` → 429/503 + `Retry-After`.

**Login (`/api/login`, `/api/password`):** `createLoginLockout({maxFails:5, lockS:60, windowS:600, maxKeys})`; `check(user, addr)` and `fail(user, addr)` return lock seconds left (0 = ok) — if `> 0` respond `errors.locked(secs)`. Call `fail` on bad credentials, `success` on good. Pair with a per-address rate limit to stop username-spray eviction. Passwords **must** use `hashPasswordAsync`/`verifyPasswordAsync` from `security.ts` (event-loop-safe, DoS-bounded, format-identical to `scrypt$ln$r$p$salt$dk`) — never the sync `store.ts` helpers inside a request handler; truncate password input to 256 chars like Python did.

**Proxy forward path:**

1. `bodyWithinLimit(content-length, L)` then `readLimitedBody(body, L)` or `body.pipeThrough(limitBodyStream(L))`; over-limit → `errors.tooLarge()` (413). Pick L ~8 MB.
2. Rate-limit (global + per-key), then pick candidates, then **reserve before forwarding**: `tryReserve(`${canon}|${pool}`, est, room)` from `createReservationLedger` — atomic check-and-hold, fixes the overspend race. `res.settle()` in `finally` after booking actual cost; `res.release()` on any failure/abort path — both are exactly-once.
3. Forward with `filterRequestHeaders(req.headers)` — drops hop-by-hop, `authorization`, `x-api-key`, `cookie`, `accept-encoding`, `x-mw*` — then set upstream `Authorization` yourself. Reply headers through `filterResponseHeaders(resp.headers)` (drops hop-by-hop + `set-cookie`).
4. Concurrency: wrap the upstream call in `createQueue({concurrency, maxPending, timeoutMs})`; full queue → `errors.queueFull()` (503 + `Retry-After`). Link the client socket abort to `run(fn, {signal})` so disconnects abort the upstream fetch (`AbortSignal.any`/`AbortSignal.timeout` for connect vs read timeouts).
5. Retry only when the request provably never left (connect errors), never after send — otherwise double-charge. On 401/402/403/429 upstream, mark the pool blocked (30 s on 429, 600 s otherwise) like Python.
6. Booking: hold the reservation across the whole response (including SSE stream end and client-disconnect `finally`); write the ledger row, then `settle()` — never `settle` before the DB write or the room check opens a hole.
7. Log upstream errors via `redactSecrets(text, [resolvedKeys])`.

**Web API sessions:** keep `mw_session` `HttpOnly; SameSite=Strict; Path=/`; add `Secure` only if https is ever configured. Rotate on login (new token per login already does), delete other sessions on password change (exists). Touch `last_seen` on use and expire idle sessions (new requirement, not in Python).

**Static/UI:** serve assets from a fixed allowlist or check `safePathSegment(name)` before joining paths.

**DB:** keep WAL; set a busy timeout on `DatabaseSync` (node:sqlite `timeout` option); wrap multi-row writes (user delete, config migration) in `BEGIN IMMEDIATE`/`COMMIT` so they stay atomic.

**Shutdown:** drain `Queue.pending === 0 && Queue.active === 0` (or a grace timeout), abort stragglers via their signals, then close the DB.
