"""Token pricing. Prices are USD per 1M tokens (docs.mistral.ai/inference/pricing, 2026-11-16)."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Price:
    input: float
    output: float
    cached: float | None = None  # cached-input price; None -> input price


PRICES_USD: dict[str, Price] = {
    "mistral-large-4-0": Price(0.70, 2.10, 0.07),
    "mistral-small-4": Price(0.15, 0.60, 0.015),
    # Medium 3.5 has no price on the official page (deprecated 2026-10-31); third-party figure, unverified.
    "mistral-medium-3-5": Price(1.50, 7.50),
    "zai-glm-5-3": Price(1.40, 4.40, 0.14),
    "zai-glm-5-3-flash": Price(0.15, 0.50, 0.03),
    "deepseek-v4-1-flash-1017": Price(0.30, 1.20, 0.007),
    "ministral-3-14b": Price(0.20, 0.20, 0.02),
    "ministral-3-8b": Price(0.15, 0.15, 0.015),
    "ministral-3-3b": Price(0.10, 0.10, 0.01),
    "codestral": Price(0.30, 0.90, 0.03),
    "codestral-embed": Price(0.15, 0.0, 0.015),
    "mistral-embed": Price(0.10, 0.0, 0.01),
}

ALIASES = {
    "mistral-large-4-0-3": "mistral-large-4-0",
    "mistral-large-4": "mistral-large-4-0",
    "mistral-large-latest": "mistral-large-4-0",
    "mistral-small-2603": "mistral-small-4",
    "mistral-small-latest": "mistral-small-4",
    "mistral-medium-latest": "mistral-medium-3-5",
    "mistral-medium": "mistral-medium-3-5",
    "mistral-medium-3.5": "mistral-medium-3-5",
    "mistral-vibe-cli-latest": "mistral-medium-3-5",
    "mistral-vibe-cli-fast": "mistral-small-4",
    "ministral-3b-latest": "ministral-3-3b", "ministral-3b-2512": "ministral-3-3b",
    "ministral-8b-latest": "ministral-3-8b", "ministral-8b-2512": "ministral-3-8b",
    "ministral-14b-latest": "ministral-3-14b", "ministral-14b-2512": "ministral-3-14b",
    "glm-5-3": "zai-glm-5-3",
    "zai-glm-5": "zai-glm-5-3",
    "zai-glm-latest": "zai-glm-5-3",
    "codestral-latest": "codestral",
    "codestral-2508": "codestral",
}

# Unknown models are priced like Large 4 (pessimistic-ish) and flagged as estimates.
FALLBACK = Price(0.70, 2.10, 0.07)

PRICES_PER_1K_PAGES_USD = {"ocr": 4.0}


class PriceBook:
    def __init__(self, usd_to_eur: float, overrides: dict[str, dict] | None = None):
        self.fx = usd_to_eur
        self.prices = dict(PRICES_USD)
        for model, p in (overrides or {}).items():
            self.prices[model] = Price(float(p["input"]), float(p["output"]), p.get("cached"))

    def lookup(self, model: str | None) -> tuple[Price, bool]:
        """Returns (price, exact). exact=False means fallback pricing was used."""
        m = (model or "").lower()
        m = ALIASES.get(m, m)
        if m in self.prices:
            return self.prices[m], True
        # prefix match, e.g. "ministral-3-8b-2512" or "codestral-25.08"
        for key in sorted(self.prices, key=len, reverse=True):
            if m.startswith(key):
                return self.prices[key], True
        return FALLBACK, False

    def cost_eur(
        self, model: str | None, prompt: int, completion: int, cached: int = 0
    ) -> tuple[float, bool]:
        p, exact = self.lookup(model)
        cached = min(max(cached, 0), prompt)
        cached_price = p.cached if p.cached is not None else p.input
        usd = ((prompt - cached) * p.input + cached * cached_price + completion * p.output) / 1e6
        return usd * self.fx, exact

    def pages_cost_eur(self, pages: int) -> float:
        return pages / 1000 * PRICES_PER_1K_PAGES_USD["ocr"] * self.fx
