"""Browser sign-in to Mistral, the same flow Vibe CLI uses for `vibe --setup`.

1. POST {console}/api/vibe/sign-in with a PKCE challenge -> process_id, sign_in_url, poll_url
2. The user signs in at sign_in_url in their own browser; we poll poll_url (pending -> completed)
3. POST .../exchange with exchange_token + code_verifier -> an API key for the chosen workspace

No client id, no redirect URI, no secrets of ours. The endpoints are Mistral's (undocumented, taken from the
Vibe CLI sources), so they can change; failures are reported to the UI instead of being swallowed.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import posixpath
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import urlsplit

import httpx

from .sync import USER_AGENT, sync_all

log = logging.getLogger("mistwatch.signin")

CONSOLE_URL = "https://console.mistral.ai"
API_URL = CONSOLE_URL + "/api"
MAX_ACTIVE = 5
KEEP_FINISHED_S = 600
WORKSPACE_DENIED_CODE = 9004
WORKSPACE_DENIED_MSG = ("This workspace cannot be used for Vibe. Sign in again and choose a different workspace "
                        "in the browser, or contact your administrator.")


class SignInError(Exception):
    """Message is safe to show in the UI."""


@dataclass
class Attempt:
    id: str
    account: str
    pool: str
    process_id: str
    sign_in_url: str
    poll_url: str
    verifier: str
    expires_at: float
    status: str = "pending"  # pending | exchanging | done | error | expired | denied | cancelled
    message: str = ""
    synced: dict = field(default_factory=dict)
    finished_at: float = 0.0
    task: asyncio.Task | None = None

    def public(self) -> dict:
        return {"id": self.id, "account": self.account, "pool": self.pool, "status": self.status,
                "message": self.message, "sign_in_url": self.sign_in_url, "expires_at": self.expires_at,
                "synced": self.synced}


def _origin(u) -> tuple[str, str | None, int | None]:
    port = u.port if u.port is not None else {"https": 443, "http": 80}.get(u.scheme.lower())
    return u.scheme.lower(), u.hostname, port


def _check_url(value: str, base: str) -> str:
    """The URLs Mistral hands back must stay on the console origin and under the expected path."""
    u, b = urlsplit(value), urlsplit(base)
    if u.scheme != "https" or u.username or u.password or _origin(u) != _origin(b):
        raise SignInError("Mistral returned an unexpected sign-in URL.")
    path, base_path = posixpath.normpath(u.path or "/"), posixpath.normpath(b.path or "/").rstrip("/")
    if base_path and path != base_path and not path.startswith(base_path + "/"):
        raise SignInError("Mistral returned an unexpected sign-in URL.")
    return value


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode().rstrip("=")
    return verifier, challenge


class SignInManager:
    def __init__(self, st, poll_interval: float = 3.0):
        self.st = st
        self.poll_interval = poll_interval
        self.attempts: dict[str, Attempt] = {}

    def get(self, attempt_id: str) -> Attempt | None:
        return self.attempts.get(attempt_id)

    def _gc(self) -> None:
        now = time.time()
        for k in [k for k, a in self.attempts.items() if a.finished_at and now - a.finished_at > KEEP_FINISHED_S]:
            del self.attempts[k]

    def cancel(self, attempt_id: str) -> bool:
        a = self.attempts.get(attempt_id)
        if not a:
            return False
        if a.status in ("pending", "exchanging"):
            self._finish(a, "cancelled", "Sign-in cancelled.")
        if a.task:
            a.task.cancel()
        return True

    def _finish(self, a: Attempt, status: str, message: str = "") -> None:
        a.status, a.message, a.finished_at = status, message, time.time()

    async def start(self, account: str, pool: str) -> Attempt:
        self._gc()
        active = [a for a in self.attempts.values() if a.status in ("pending", "exchanging")]
        for a in active:  # one attempt per slot: a new click replaces the old one
            if (a.account, a.pool) == (account, pool):
                self.cancel(a.id)
        if len([a for a in active if a.status in ("pending", "exchanging")]) >= MAX_ACTIVE:
            raise SignInError("Too many sign-ins in progress.")
        verifier, challenge = pkce_pair()
        try:
            r = await self.st.http.post(f"{API_URL}/vibe/sign-in", timeout=20,
                                        headers={"User-Agent": USER_AGENT},
                                        json={"code_challenge": challenge, "code_challenge_method": "S256"})
        except httpx.HTTPError as e:
            raise SignInError(f"Cannot reach Mistral ({type(e).__name__}).") from e
        if not r.is_success:
            raise SignInError(f"Mistral refused to start the sign-in (HTTP {r.status_code}).")
        try:
            d = r.json()
            exp = datetime.fromisoformat(d["expires_at"].replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
            a = Attempt(id=secrets.token_urlsafe(12), account=account, pool=pool, process_id=str(d["process_id"]),
                        sign_in_url=_check_url(d["sign_in_url"], CONSOLE_URL),
                        poll_url=_check_url(d["poll_url"], API_URL), verifier=verifier, expires_at=exp)
        except (KeyError, TypeError, ValueError) as e:
            raise SignInError("Mistral returned an unexpected response.") from e
        self.attempts[a.id] = a
        a.task = asyncio.create_task(self._run(a))
        return a

    async def _run(self, a: Attempt) -> None:
        fails = 0
        try:
            while time.time() < a.expires_at:
                try:
                    r = await self.st.http.get(a.poll_url, timeout=20, headers={"User-Agent": USER_AGENT})
                    if r.status_code == 410:
                        return self._finish(a, "expired", "Sign-in expired.")
                    r.raise_for_status()
                    p = r.json()
                    fails = 0
                except (httpx.HTTPError, ValueError):
                    fails += 1
                    if fails >= 3:
                        return self._finish(a, "error", "Could not check the sign-in status.")
                    await asyncio.sleep(self.poll_interval)
                    continue
                status = p.get("status")
                if status == "pending":
                    await asyncio.sleep(self.poll_interval)
                elif status == "completed":
                    if not p.get("exchange_token"):
                        return self._finish(a, "error", "Sign-in succeeded, but the token to finish it is missing.")
                    return await self._exchange(a, p["exchange_token"])
                elif status == "expired":
                    return self._finish(a, "expired", "Sign-in expired.")
                elif status == "denied":
                    return self._finish(a, "denied", "Sign-in was denied.")
                else:
                    return self._finish(a, "error", p.get("message") or "Sign-in failed.")
            self._finish(a, "expired", "Sign-in expired.")
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - never leave an attempt hanging as "pending"
            log.exception("sign-in task failed")
            self._finish(a, "error", "Unexpected error during sign-in.")

    async def _exchange(self, a: Attempt, exchange_token: str) -> None:
        a.status = "exchanging"
        try:
            r = await self.st.http.post(f"{API_URL}/vibe/sign-in/{a.process_id}/exchange", timeout=20,
                                        headers={"User-Agent": USER_AGENT},
                                        json={"exchange_token": exchange_token, "code_verifier": a.verifier})
        except httpx.HTTPError as e:
            return self._finish(a, "error", f"Exchanging for a key failed ({type(e).__name__}).")
        if not r.is_success:
            denied = False
            try:
                denied = r.status_code == 403 and r.json().get("error_code") == WORKSPACE_DENIED_CODE
            except (ValueError, AttributeError):
                pass
            return self._finish(a, "error", WORKSPACE_DENIED_MSG if denied else f"Exchanging for a key failed (HTTP {r.status_code}).")
        try:
            key = r.json().get("api_key")
        except ValueError:
            key = None
        if not key:
            return self._finish(a, "error", "Mistral did not return an API key.")
        st = self.st
        try:
            st.store.set_key(a.account, a.pool, value=key)
        except Exception as e:  # noqa: BLE001 - e.g. the account was deleted meanwhile
            return self._finish(a, "error", str(e))
        st.reload_accounts()
        st.blocked_until.clear()
        try:
            a.synced = (await sync_all(st.http, st.cfg, st.db)).get(a.account, {})
            st.last_sync = time.time()
        except Exception:  # noqa: BLE001
            log.exception("sync after sign-in")
        self._finish(a, "done", "Signed in.")
