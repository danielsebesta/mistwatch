"""Tiny-LLM difficulty rater used by the `auto` router for ambiguous prompts.

One short call to a small model (Ministral 3B: ~120 prompt tokens, ~300-400 ms, ~$0.00001).
Any failure or timeout returns None and the router falls back to its heuristics.
"""
from __future__ import annotations

import hashlib
import logging
import re
from collections import OrderedDict

import httpx

from .router import _text

log = logging.getLogger("dast_mistral.classifier")

SYSTEM = (
    "Rate how hard the user's last request is for an AI assistant on a 0-10 integer scale. "
    "0-1 greeting or trivial; 2-3 simple question, short edit, translation; "
    "4-5 moderate coding or analysis; 6-7 multi-step debugging, design, long reasoning; "
    "8-10 research-grade, hard math or proofs, large system design. "
    'Reply with JSON only: {"difficulty": <int>}'
)
_NUM = re.compile(r'"difficulty"\s*:\s*(\d+)')
_cache: OrderedDict[str, int] = OrderedDict()
CACHE_MAX = 1024


def prompt_view(body: dict) -> str:
    msgs = [m for m in body.get("messages", []) if isinstance(m, dict)]
    last = next((_text(m.get("content")) for m in reversed(msgs) if m.get("role") == "user"), "")
    if len(last) > 1800:
        last = last[:1200] + "\n[...]\n" + last[-600:]
    notes = []
    if body.get("tools"):
        notes.append("the assistant has tools available")
    if any(m.get("role") == "tool" for m in msgs):
        notes.append("this is mid-way through an agentic tool loop")
    if len(msgs) > 10:
        notes.append(f"long conversation ({len(msgs)} messages)")
    return last + (f"\n\n[context: {'; '.join(notes)}]" if notes else "")


async def rate(http: httpx.AsyncClient, base: str, key: str, body: dict, model: str,
               timeout: float) -> tuple[int, int, int] | None:
    """Returns (difficulty 0-10, prompt_tokens, completion_tokens); tokens are 0 on a cache hit."""
    view = prompt_view(body)
    ck = hashlib.sha1(view.encode("utf-8", "ignore")).hexdigest()
    if ck in _cache:
        _cache.move_to_end(ck)
        return _cache[ck], 0, 0
    req = {"model": model, "temperature": 0, "max_tokens": 24, "response_format": {"type": "json_object"},
           "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": view}]}
    try:
        r = await http.post(f"{base}/v1/chat/completions", json=req, timeout=timeout,
                            headers={"Authorization": f"Bearer {key}", "User-Agent": "dast-mistral/0.1 router"})
        r.raise_for_status()
        data = r.json()
        m = _NUM.search(data["choices"][0]["message"]["content"])
        if not m:
            return None
        score = max(0, min(10, int(m.group(1))))
        u = data.get("usage") or {}
    except (httpx.HTTPError, KeyError, ValueError, IndexError) as e:
        log.info("classifier skipped: %s", type(e).__name__)
        return None
    _cache[ck] = score
    if len(_cache) > CACHE_MAX:
        _cache.popitem(last=False)
    return score, int(u.get("prompt_tokens", 0)), int(u.get("completion_tokens", 0))
