"""Human-readable model names.

Resolution order for a model id (first hit wins):
  1. your own override (editable in Settings, stored in the DB),
  2. the built-in table of models we know by heart,
  3. the display name Mistral's /v1/models gives (only some models have a real one, e.g. "Mistral OCR 4.1"),
  4. an automatic prettifier: "zai-glm-5-3-flash" -> "GLM 5.3 Flash", "ministral-3b-2512" -> "Ministral 3B (2512)".

Mistral's `name` field is shared by every alias of one model (large-4, large-4-0, large-latest all say
"mistral-large-4"), so that name is also the grouping key: aliases collapse into one entry in charts and
one override covers all of them.
"""
from __future__ import annotations

import json
import re
import time

import httpx

from .db import DB

REFRESH_AFTER_S = 12 * 3600

# (regex on the lower-cased id/name, display name). Only models whose naming we are sure about.
BUILTIN: list[tuple[str, str]] = [
    (r"^mistral-large-4(-0)?$|^mistral-large-latest$", "Mistral Large 4"),
    (r"^mistral-small-4$|^mistral-small-2603$|^mistral-small-latest$|^mistral-vibe-cli-fast$", "Mistral Small 4"),
    (r"^mistral-medium(-latest|-3-5|-3\.5)?$|^mistral-vibe-cli(-latest|-with-tools)?$", "Mistral Medium 3.5"),
    (r"^(zai-)?glm-5-3$|^zai-glm-(5|latest)$", "GLM 5.3"),
    (r"^(zai-)?glm-5-3-flash$", "GLM 5.3 Flash"),
    (r"^(zai-)?glm-5-2$", "GLM 5.2"),
    (r"^deepseek-v4-1-flash(-1017)?$", "DeepSeek V4.1 Flash"),
    (r"^ministral-3b(-latest|-2512)?$", "Ministral 3 3B"),
    (r"^ministral-8b(-latest|-2512)?$", "Ministral 3 8B"),
    (r"^ministral-14b(-latest|-2512)?$", "Ministral 3 14B"),
    (r"^codestral(-latest|-2508)?$|^mistral-code(-fim)?-latest$", "Codestral"),
]
_BUILTIN = [(re.compile(p), n) for p, n in BUILTIN]

BRANDS = {"glm": "GLM", "ocr": "OCR", "tts": "TTS", "gpt": "GPT", "deepseek": "DeepSeek", "llm": "LLM"}
DROP_PREFIX = {"zai"}
_VERSION = re.compile(r"^v?\d{1,2}$")
_SIZE = re.compile(r"^\d+(\.\d+)?[bkm]$")


def builtin(model_id: str) -> str | None:
    m = model_id.lower()
    for rx, name in _BUILTIN:
        if rx.match(m):
            return name
    return None


def _word(tok: str) -> str:
    if tok in BRANDS:
        return BRANDS[tok]
    if _SIZE.match(tok):
        return tok.upper()
    if re.fullmatch(r"v\d+(\.\d+)*", tok):
        return tok.upper()
    return tok.capitalize()


def autoname(model_id: str) -> str:
    """Best-effort pretty name for an id nobody has named yet."""
    toks = [t for t in re.split(r"[-_ ]+", model_id.strip().lower()) if t]
    while toks and toks[0] in DROP_PREFIX:
        toks.pop(0)
    suffix = ""
    if toks and toks[-1] == "latest":
        toks.pop()
        suffix = " (latest)"
    elif len(toks) > 1 and re.fullmatch(r"\d{4}", toks[-1]):  # a YYMM-style snapshot, kept but set apart
        suffix = f" ({toks.pop()})"
    out: list[str] = []
    i = 0
    while i < len(toks):
        t = toks[i]
        if _VERSION.match(t) and i + 1 < len(toks) and re.fullmatch(r"\d{1,2}", toks[i + 1]):
            parts = [t]
            i += 1
            while i < len(toks) and re.fullmatch(r"\d{1,2}", toks[i]):
                parts.append(toks[i])
                i += 1
            while len(parts) > 1 and parts[-1] == "0":  # 4-0 -> 4
                parts.pop()
            out.append(".".join(p.upper() if p.startswith("v") else p for p in parts))
            continue
        out.append(_word(t))
        i += 1
    return " ".join(out) + suffix or model_id


def _looks_human(name: str) -> bool:
    return " " in name or any(c.isupper() for c in name)


class ModelNames:
    def __init__(self, db: DB):
        self.db = db
        self._over: dict[str, str] = {}
        self._cat: dict[str, dict] = {}
        self.reload()

    # ----- storage
    def reload(self) -> None:
        with self.db.lock:
            self._over = {r[0]: r[1] for r in self.db.conn.execute("SELECT model_id, display FROM model_names")}
            self._cat = {r[0]: {"name": r[1], "aliases": json.loads(r[2] or "[]"), "description": r[3]}
                         for r in self.db.conn.execute("SELECT model_id, name, aliases, description FROM model_catalog")}

    def group_key(self, model_id: str) -> str:
        c = self._cat.get(model_id)
        return (c["name"] if c and c["name"] else model_id)

    def set_override(self, model_id: str, display: str) -> None:
        display = display.strip()
        if not display or len(display) > 80 or any(ord(ch) < 32 for ch in display):
            raise ValueError("Name must be 1-80 printable characters.")
        with self.db.lock:
            self.db.conn.execute("INSERT INTO model_names(model_id, display) VALUES(?,?) "
                                 "ON CONFLICT(model_id) DO UPDATE SET display=excluded.display", (self.group_key(model_id), display))
            self.db.conn.commit()
        self.reload()

    def clear_override(self, model_id: str) -> None:
        with self.db.lock:
            self.db.conn.execute("DELETE FROM model_names WHERE model_id IN (?,?)", (model_id, self.group_key(model_id)))
            self.db.conn.commit()
        self.reload()

    # ----- resolution
    def resolve(self, model_id: str | None) -> tuple[str, str]:
        """Returns (display name, source) with source in custom | built-in | mistral | auto."""
        m = (model_id or "").strip()
        if not m:
            return "(unknown)", "auto"
        key = self.group_key(m)
        for k in (m, key):
            if k in self._over:
                return self._over[k], "custom"
        for k in (m, key):
            b = builtin(k)
            if b:
                return b, "built-in"
        if key != m and _looks_human(key):
            return key, "mistral"
        return autoname(key), "auto"

    def display(self, model_id: str | None) -> str:
        return self.resolve(model_id)[0]

    # ----- Mistral catalog
    async def refresh(self, http: httpx.AsyncClient, base: str, key: str) -> int:
        r = await http.get(f"{base}/v1/models", headers={"Authorization": f"Bearer {key}", "User-Agent": "mistwatch/0.1"}, timeout=20)
        r.raise_for_status()
        rows = [(m["id"], m.get("name"), json.dumps(m.get("aliases") or []), m.get("description"))
                for m in r.json().get("data", []) if isinstance(m, dict) and m.get("id")]
        if not rows:
            return 0
        with self.db.lock:
            self.db.conn.execute("DELETE FROM model_catalog")
            self.db.conn.executemany("INSERT INTO model_catalog(model_id, name, aliases, description) VALUES(?,?,?,?)", rows)
            self.db.conn.commit()
        self.db.set_meta("catalog_ts", str(time.time()))
        self.reload()
        return len(rows)

    async def maybe_refresh(self, http: httpx.AsyncClient, base: str, accounts) -> int | None:
        last = float(self.db.get_meta("catalog_ts") or 0)
        if time.time() - last < REFRESH_AFTER_S:
            return None
        for a in accounts:
            for pool in a.keys:
                try:
                    return await self.refresh(http, base, a.key_for(pool))
                except Exception:  # noqa: BLE001 - try the next key; the names fall back to the prettifier
                    continue
        return None

    # ----- for the settings page
    def listing(self, include_all: bool = False) -> list[dict]:
        with self.db.lock:
            seen = {r[0]: (r[1], r[2]) for r in self.db.conn.execute(
                "SELECT model, COUNT(*), MAX(ts) FROM ledger WHERE model IS NOT NULL GROUP BY model")}
        from .router import LADDER  # models the auto router can pick are worth naming up front

        ids = set(seen) | {s.model for s in LADDER}
        if include_all:
            ids |= set(self._cat)
        groups: dict[str, dict] = {}
        for i in sorted(ids):
            g = groups.setdefault(self.group_key(i), {"ids": [], "calls": 0, "last": 0.0})
            g["ids"].append(i)
            n, last = seen.get(i, (0, 0.0))
            g["calls"] += n
            g["last"] = max(g["last"], last or 0.0)
        for k in self._over:  # an override whose model was never seen is still listed so it can be removed
            groups.setdefault(k, {"ids": [k], "calls": 0, "last": 0.0})
        out = []
        for k, g in groups.items():
            display, source = self.resolve(g["ids"][0])
            out.append({"key": k, "ids": g["ids"], "display": display, "source": source, "calls": g["calls"], "last": g["last"] or None,
                        "description": (self._cat.get(g["ids"][0]) or {}).get("description")})
        return sorted(out, key=lambda r: (-r["calls"], r["display"].lower()))
