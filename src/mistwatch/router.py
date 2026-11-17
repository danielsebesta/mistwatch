"""`auto` model: guess how hard a request is and pick model + reasoning effort.

Pure heuristics, no network, ~microseconds. The score (0-10) is built from cheap signals in the
request (size, code, keywords in EN/CS, tools, agent history, images). It maps onto a fixed ladder of
(model, effort) steps; budget pressure from the pacing engine can only move the choice *down*.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Step:
    model: str
    effort: str | None
    vision: bool
    ctx: int
    label: str


# Ladder from cheapest to strongest (order set by the user: GLM Flash < Large 4 < DeepSeek < GLM 5.3).
# Effort values verified against the live API: Small none/high, Large 4 low/medium/high,
# DeepSeek none/low/high/max/xhigh (no medium), GLM 5.3 low/high/max (no none/medium).
LADDER: list[Step] = [
    Step("mistral-small-2603", "none", True, 262_144, "small/none"),
    Step("zai-glm-5-3-flash", "low", True, 1_048_576, "glm-flash/low"),
    Step("mistral-large-4-0", "medium", True, 1_048_576, "large-4/medium"),
    Step("mistral-large-4-0", "high", True, 1_048_576, "large-4/high"),
    Step("deepseek-v4-1-flash-1017", "high", True, 1_048_576, "deepseek/high"),
    Step("zai-glm-5-3", "high", False, 1_048_576, "glm-5.3/high"),
    Step("zai-glm-5-3", "max", False, 1_048_576, "glm-5.3/max"),
]
TOP = len(LADDER) - 1
LLM_WEIGHT = 0.8
SCORE_TO_LEVEL = [(1, 0), (3, 1), (4, 2), (5, 3), (6, 4), (8, 5), (10, 6)]  # score <= x -> level
VALID_EFFORT = {
    "mistral-small-2603": {"none", "high"},
    "mistral-large-4-0": {"low", "medium", "high"},
    "deepseek-v4-1-flash-1017": {"none", "low", "high", "max", "xhigh"},
    "zai-glm-5-3": {"low", "high", "max"},
    "zai-glm-5-3-flash": {"low", "high", "max"},
}

AUTO_MODELS = {"auto": (0, TOP), "auto-fast": (0, 2), "auto-max": (4, TOP)}  # name -> (min level, max level)

HARD = re.compile(
    r"\b(debug\w*|bug|refactor\w*|architect\w*|design|optimi[sz]\w*|prove|proof|algorithm\w*|race condition|"
    r"deadlock|security|vulnerab\w*|migrat\w*|implement\w*|rewrite|analy[sz]\w*|investigat\w*|root cause|"
    r"concurren\w*|performance|benchmark\w*|navrhni|architektur\w*|refaktor\w*|oprav\w*|optimaliz\w*|"
    r"analyz\w*|implementuj|zjisti|přepiš|migrac\w*|bezpečnost\w*|chyb\w*)\b", re.I)
THINK = re.compile(r"step[- ]by[- ]step|think (hard|carefully)|carefully|rigorous|krok za krokem|důkladn\w+|pořádně", re.I)
EASY = re.compile(r"^\s*(hi|hello|hey|thanks?|ok|ahoj|čau|díky|dík)\b|\b(translate|přelož\w*|summari[sz]e|shrň\w*|"
                  r"typo|rename|format|co je|what is|what's|kolik je)\b", re.I)
TRACE = re.compile(r"Traceback \(most recent|^\s+at .+\(.+:\d+\)|\bException\b|\bpanic:|error\[E\d+\]|Segmentation fault", re.M)
LIST = re.compile(r"(?:^\s*|\s)(\d{1,2}[.)]|[-*•])\s+\S", re.M)


@dataclass
class Decision:
    model: str
    effort: str | None
    level: int
    score: int
    reason: str
    llm_score: int | None = None

    def header(self) -> str:
        extra = f";llm={self.llm_score}" if self.llm_score is not None else ""
        return f"{self.model};effort={self.effort};level={self.level};score={self.score}{extra}"


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


def _has_image(messages: list) -> bool:
    for m in messages:
        c = m.get("content")
        if isinstance(c, list) and any(isinstance(p, dict) and p.get("type") in ("image_url", "image") for p in c):
            return True
    return False


def score_request(body: dict) -> tuple[int, list[str], int, bool]:
    """Returns (score 0-10, reasons, estimated prompt tokens, has_image)."""
    msgs = [m for m in body.get("messages", []) if isinstance(m, dict)]
    last_user = next((_text(m.get("content")) for m in reversed(msgs) if m.get("role") == "user"), "")
    total_chars = sum(len(_text(m.get("content"))) for m in msgs)
    est_tokens = total_chars // 4
    s, why = 0, []

    def add(n: int, r: str):
        nonlocal s
        s += n
        why.append(f"{n:+d} {r}")

    n = len(last_user)
    if n > 400: add(1, "long prompt")
    if n > 1500: add(1, "very long prompt")
    if n > 6000: add(1, "huge prompt")
    if "```" in last_user or "```" in " ".join(_text(m.get("content")) for m in msgs[-3:]): add(1, "code")
    if TRACE.search(last_user): add(1, "stack trace")
    hard = {m.group(0).lower() for m in HARD.finditer(last_user)}
    if len(hard) >= 4: add(3, f"many hard keywords {sorted(hard)[:4]}")
    elif len(hard) >= 3: add(2, f"hard keywords {sorted(hard)[:4]}")
    elif hard: add(1, f"hard keyword {sorted(hard)[0]}")
    if THINK.search(last_user): add(1, "asks for careful reasoning")
    if len(LIST.findall(last_user)) >= 3: add(1, "multi-part")
    if body.get("tools"): add(2, "tools available")
    if any(m.get("role") == "tool" for m in msgs): add(1, "agent loop")
    if len(msgs) > 10: add(1, "long conversation")
    if est_tokens > 30_000: add(1, "large context")
    if est_tokens > 100_000: add(1, "huge context")
    if n < 200 and EASY.search(last_user): add(-1, "easy pattern")
    if n < 40 and not hard: add(-1, "tiny prompt")
    return max(0, min(10, s)), why, est_tokens, _has_image(msgs)


def worth_asking(body: dict, score: int) -> bool:
    """Ask the tiny LLM unless the answer is obvious: a very short prompt or an already clearly hard one.

    Heuristics are weakest on short-but-hard prompts, so a low score is NOT a reason to skip."""
    msgs = [m for m in body.get("messages", []) if isinstance(m, dict)]
    last = next((_text(m.get("content")) for m in reversed(msgs) if m.get("role") == "user"), "")
    return len(last.strip()) >= 30 and score < 8


def decide(body: dict, name: str = "auto", pressure: float = 1.0, llm_score: int | None = None) -> Decision:
    """pressure = fraction of the tightest budget window still free (1.0 = plenty, 0 = none)."""
    lo, hi = AUTO_MODELS.get(name, (0, TOP))
    score, why, tokens, image = score_request(body)
    if llm_score is not None:
        blended = round((1 - LLM_WEIGHT) * score + LLM_WEIGHT * llm_score)
        why.append(f"tiny-LLM says {llm_score}, heuristic {score} -> {blended}")
        score = blended
    level = next(lv for bound, lv in SCORE_TO_LEVEL if score <= bound)
    level = max(lo, min(hi, level))
    if body.get("tools") and level < 2 and score >= 4:
        level = 2; why.append("tools+hard -> large-4")
    # budget pressure only ever downgrades
    drop = 2 if pressure < 0.10 else 1 if pressure < 0.25 else 0
    if drop:
        level = max(lo if lo <= 1 else 1, level - drop)
        why.append(f"budget pressure {pressure:.0%} -> -{drop}")
    step = LADDER[level]
    if image and not step.vision:
        while not LADDER[level].vision:
            level -= 1
        step = LADDER[level]; why.append("image -> vision model")
    if tokens > 200_000 and step.ctx < 400_000:
        level = max(level, 1); step = LADDER[level]; why.append("long context -> 1M model")
    effort = step.effort
    asked = body.get("reasoning_effort")
    if asked and asked in VALID_EFFORT.get(step.model, set()):
        effort = asked; why.append(f"client effort {asked} kept")
    return Decision(step.model, effort, level, score, "; ".join(why) or "default", llm_score)


def apply(body: dict, d: Decision) -> dict:
    out = dict(body)
    out["model"] = d.model
    if d.effort:
        out["reasoning_effort"] = d.effort
    else:
        out.pop("reasoning_effort", None)
    return out
