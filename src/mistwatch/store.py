"""App state kept in SQLite: login accounts, sessions, proxy API keys, and Mistral accounts + their keys.

* Passwords: scrypt with a random salt (stdlib), compared in constant time.
* Sessions and proxy API keys: only the SHA-256 of the random token is stored.
* Mistral keys cannot be hashed (they must be sent upstream), so they go into the OS keyring when one is
  available (Windows Credential Manager); the DB only holds a reference. Without a keyring they are stored
  in the DB file as-is - that file lives in the user's home directory.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time

from .config import Account, Config, resolve_secret
from .db import DB

NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,40}$")  # API key names
ACCOUNT_RE = re.compile(r"^[A-Za-z0-9._+@-]{1,80}$")  # account names may be e-mail addresses
POOLS = ("vibe", "api")
SESSION_TTL = 30 * 86400
KEYRING_SERVICE = "mistwatch"
VIBE_REF = "keyring:ai.mistral.vibe/MISTRAL_API_KEY"
MIN_PASSWORD = 10


class StoreError(ValueError):
    """User-facing validation error."""


# ---------- passwords ----------
_LOG_N, _R, _P = 15, 8, 1


def _scrypt(pw: str, salt: bytes, log_n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(pw.encode("utf-8"), salt=salt, n=1 << log_n, r=r, p=p,
                          maxmem=256 * 1024 * 1024, dklen=32)


def hash_password(pw: str) -> str:
    salt = os.urandom(16)
    dk = _scrypt(pw, salt, _LOG_N, _R, _P)
    b64 = lambda x: base64.b64encode(x).decode()  # noqa: E731
    return f"scrypt${_LOG_N}${_R}${_P}${b64(salt)}${b64(dk)}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        algo, ln, r, p, salt, dk = stored.split("$")
        if algo != "scrypt":
            return False
        calc = _scrypt(pw, base64.b64decode(salt), int(ln), int(r), int(p))
        return hmac.compare_digest(calc, base64.b64decode(dk))
    except (ValueError, TypeError):
        return False


_DUMMY = hash_password("dummy-password-for-timing")


def _sha(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def check_password_policy(pw: str) -> None:
    if len(pw) < MIN_PASSWORD:
        raise StoreError(f"Password must be at least {MIN_PASSWORD} characters.")
    if len(pw) > 256:
        raise StoreError("Password is too long.")


# ---------- secret references ----------
def ref_kind(ref: str) -> str:
    if ref == VIBE_REF:
        return "vibe-cli"
    if ref.startswith("keyring:"):
        return "keyring"
    if ref.startswith("env:"):
        return "env"
    return "inline"


def mask(key: str) -> str:
    return (key[:5] + "…" + key[-4:]) if len(key) > 12 else "…" + key[-3:]


def save_secret(account: str, pool: str, value: str) -> str:
    """Stores a key and returns the reference to keep in the DB."""
    if os.environ.get("MISTWATCH_NO_KEYRING"):
        return value
    try:
        import keyring

        user = f"{account}/{pool}"
        keyring.set_password(KEYRING_SERVICE, user, value)
        if keyring.get_password(KEYRING_SERVICE, user) == value:
            return f"keyring:{KEYRING_SERVICE}/{user}"
    except Exception:  # noqa: BLE001 - no usable keyring on this machine
        pass
    return value


def drop_secret(ref: str) -> None:
    if ref.startswith(f"keyring:{KEYRING_SERVICE}/"):
        try:
            import keyring

            keyring.delete_password(KEYRING_SERVICE, ref[8:].partition("/")[2])
        except Exception:  # noqa: BLE001
            pass


def vibe_cli_key_present() -> bool:
    try:
        import keyring

        return bool(keyring.get_password("ai.mistral.vibe", "MISTRAL_API_KEY"))
    except Exception:  # noqa: BLE001
        return False


class Store:
    def __init__(self, db: DB):
        self.db = db
        self._touched: dict[int, float] = {}

    # -- helpers
    def _q(self, sql: str, args=()):
        with self.db.lock:
            return self.db.conn.execute(sql, args).fetchall()

    def _x(self, sql: str, args=()):
        with self.db.lock:
            cur = self.db.conn.execute(sql, args)
            self.db.conn.commit()
            return cur

    # -- users
    def count_users(self) -> int:
        return self._q("SELECT COUNT(*) FROM users")[0][0]

    def list_users(self) -> list[dict]:
        return [dict(r) for r in self._q("SELECT id, username, created FROM users ORDER BY id")]

    def create_user(self, username: str, password: str) -> int:
        username = username.strip()
        if not re.fullmatch(r"[A-Za-z0-9._@-]{2,40}", username):
            raise StoreError("Username: 2-40 characters, letters, digits and . _ - @")
        check_password_policy(password)
        if self._q("SELECT 1 FROM users WHERE username=?", (username,)):
            raise StoreError("A user with this name already exists.")
        return self._x("INSERT INTO users(username, pw_hash, created) VALUES(?,?,?)",
                       (username, hash_password(password), time.time())).lastrowid

    def verify_login(self, username: str, password: str) -> dict | None:
        rows = self._q("SELECT id, username, pw_hash FROM users WHERE username=?", (username.strip(),))
        if not rows:
            verify_password(password, _DUMMY)  # keep timing similar for unknown users
            return None
        r = rows[0]
        return {"id": r["id"], "username": r["username"]} if verify_password(password, r["pw_hash"]) else None

    def set_password(self, user_id: int, password: str) -> None:
        check_password_policy(password)
        self._x("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(password), user_id))

    def check_user_password(self, user_id: int, password: str) -> bool:
        rows = self._q("SELECT pw_hash FROM users WHERE id=?", (user_id,))
        return bool(rows) and verify_password(password, rows[0]["pw_hash"])

    def delete_user(self, user_id: int) -> None:
        if self.count_users() <= 1:
            raise StoreError("The last user cannot be deleted.")
        self._x("DELETE FROM sessions WHERE user_id=?", (user_id,))
        self._x("DELETE FROM users WHERE id=?", (user_id,))

    def find_user(self, username: str) -> dict | None:
        rows = self._q("SELECT id, username FROM users WHERE username=?", (username,))
        return dict(rows[0]) if rows else None

    # -- sessions
    def create_session(self, user_id: int) -> str:
        tok = secrets.token_urlsafe(32)
        now = time.time()
        self._x("DELETE FROM sessions WHERE expires<?", (now,))
        self._x("INSERT INTO sessions(token_hash, user_id, created, last_seen, expires) VALUES(?,?,?,?,?)",
                (_sha(tok), user_id, now, now, now + SESSION_TTL))
        return tok

    def get_session(self, token: str | None) -> dict | None:
        if not token:
            return None
        rows = self._q("SELECT u.id, u.username, s.expires FROM sessions s JOIN users u ON u.id=s.user_id "
                       "WHERE s.token_hash=?", (_sha(token),))
        if not rows or rows[0]["expires"] < time.time():
            return None
        return {"id": rows[0]["id"], "username": rows[0]["username"]}

    def delete_session(self, token: str | None) -> None:
        if token:
            self._x("DELETE FROM sessions WHERE token_hash=?", (_sha(token),))

    def delete_other_sessions(self, user_id: int, keep_token: str | None) -> None:
        self._x("DELETE FROM sessions WHERE user_id=? AND token_hash<>?", (user_id, _sha(keep_token or "")))

    # -- proxy API keys
    def has_api_keys(self) -> bool:
        return bool(self._q("SELECT 1 FROM api_keys LIMIT 1"))

    def create_api_key(self, name: str) -> tuple[dict, str]:
        name = name.strip()
        if not NAME_RE.match(name):
            raise StoreError("Key name: 1-40 characters, letters, digits and . _ -")
        if self._q("SELECT 1 FROM api_keys WHERE name=?", (name,)):
            raise StoreError("A key with this name already exists.")
        secret = "mw-" + secrets.token_urlsafe(32)
        self._insert_key(name, secret)
        return self.list_api_keys(name)[0], secret

    def _insert_key(self, name: str, secret: str) -> None:
        self._x("INSERT INTO api_keys(name, prefix, key_hash, created) VALUES(?,?,?,?)",
                (name, secret[:7], _sha(secret), time.time()))

    def list_api_keys(self, name: str | None = None) -> list[dict]:
        q = "SELECT id, name, prefix, created, last_used FROM api_keys"
        rows = self._q(q + (" WHERE name=?" if name else " ORDER BY id"), (name,) if name else ())
        return [dict(r) for r in rows]

    def delete_api_key(self, key_id: int) -> bool:
        return self._x("DELETE FROM api_keys WHERE id=?", (key_id,)).rowcount > 0

    def verify_api_key(self, token: str | None) -> dict | None:
        if not token:
            return None
        rows = self._q("SELECT id, name FROM api_keys WHERE key_hash=?", (_sha(token),))
        if not rows:
            return None
        kid = rows[0]["id"]
        now = time.time()
        if now - self._touched.get(kid, 0) > 60:  # don't write on every request
            self._touched[kid] = now
            self._x("UPDATE api_keys SET last_used=? WHERE id=?", (now, kid))
        return {"id": kid, "name": rows[0]["name"]}

    # -- Mistral accounts
    @staticmethod
    def _account(r) -> Account:
        return Account(name=r["name"], keys=json.loads(r["keys"]), priority=r["priority"],
                       enabled=bool(r["enabled"]), manual=json.loads(r["manual"]))

    def list_accounts(self) -> list[Account]:
        return [self._account(r) for r in self._q("SELECT * FROM accounts ORDER BY priority, id")]

    def get_account(self, name: str) -> Account | None:
        rows = self._q("SELECT * FROM accounts WHERE name=?", (name,))
        return self._account(rows[0]) if rows else None

    def create_account(self, name: str, priority: int = 100) -> None:
        name = name.strip()
        if not ACCOUNT_RE.match(name):
            raise StoreError("Account name (may be an e-mail): 1-80 characters, letters, digits and . _ + @ -")
        if self.get_account(name):
            raise StoreError("An account with this name already exists.")
        self._x("INSERT INTO accounts(name, priority, created) VALUES(?,?,?)", (name, priority, time.time()))

    def update_account(self, name: str, enabled: bool | None = None, priority: int | None = None) -> None:
        if enabled is not None:
            self._x("UPDATE accounts SET enabled=? WHERE name=?", (int(enabled), name))
        if priority is not None:
            self._x("UPDATE accounts SET priority=? WHERE name=?", (int(priority), name))

    def delete_account(self, name: str) -> None:
        acct = self.get_account(name)
        if acct:
            for ref in acct.keys.values():
                drop_secret(ref)
        self._x("DELETE FROM accounts WHERE name=?", (name,))

    def set_key(self, name: str, pool: str, *, value: str | None = None, ref: str | None = None) -> None:
        if pool not in POOLS:
            raise StoreError("Unknown pool.")
        acct = self.get_account(name)
        if not acct:
            raise StoreError("Account does not exist.")
        if value is not None:
            value = value.strip()
            if len(value) < 8 or any(c.isspace() for c in value):
                raise StoreError("Key looks invalid.")
            new_ref = save_secret(name, pool, value)
        elif ref:
            new_ref = ref
        else:
            raise StoreError("Key is missing.")
        old = acct.keys.get(pool)
        if old and old != new_ref:
            drop_secret(old)
        acct.keys[pool] = new_ref
        self._x("UPDATE accounts SET keys=? WHERE name=?", (json.dumps(acct.keys), name))

    def remove_key(self, name: str, pool: str) -> None:
        acct = self.get_account(name)
        if acct and pool in acct.keys:
            drop_secret(acct.keys.pop(pool))
            self._x("UPDATE accounts SET keys=? WHERE name=?", (json.dumps(acct.keys), name))

    def key_info(self, acct: Account) -> dict:
        out = {}
        for pool in POOLS:
            ref = acct.keys.get(pool)
            if not ref:
                out[pool] = None
                continue
            info = {"source": ref_kind(ref), "hint": None, "ok": True}
            try:
                info["hint"] = mask(resolve_secret(ref))
            except Exception as e:  # noqa: BLE001
                info["ok"], info["error"] = False, str(e)
            out[pool] = info
        return out

    # -- one-time import of the old config.toml accounts/clients
    def migrate_config(self, cfg: Config) -> None:
        if self._q("SELECT 1 FROM meta WHERE k='config_migrated'"):
            return
        for a in cfg.accounts:
            if self.get_account(a.name):
                continue
            self.create_account(a.name, a.priority)
            for pool, ref in a.keys.items():
                keep = ref if re.match(r"^(env|keyring):", ref) else save_secret(a.name, pool, ref)
                self.set_key(a.name, pool, ref=keep)
            self.update_account(a.name, enabled=a.enabled)
            if a.manual:
                self._x("UPDATE accounts SET manual=? WHERE name=?", (json.dumps(a.manual), a.name))
        for c in cfg.clients:
            if not self._q("SELECT 1 FROM api_keys WHERE name=?", (c.name,)):
                self._insert_key(c.name, c.token)
        self._x("INSERT INTO meta(k, v) VALUES('config_migrated','1')")
