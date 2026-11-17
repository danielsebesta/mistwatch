import type { Price, PriceOverride } from "./types.ts";
export const PRICES_USD: Record<string, Price> = {
  "mistral-large-4-0": { input: 0.7, output: 2.1, cached: 0.07 },
  "mistral-small-4": { input: 0.15, output: 0.6, cached: 0.015 },
  // Medium 3.5: deprecated, no official price; unverified third-party figure.
  "mistral-medium-3-5": { input: 1.5, output: 7.5, cached: null },
  "zai-glm-5-3": { input: 1.4, output: 4.4, cached: 0.14 },
  "zai-glm-5-3-flash": { input: 0.15, output: 0.5, cached: 0.03 },
  "deepseek-v4-1-flash-1017": { input: 0.3, output: 1.2, cached: 0.007 },
  "ministral-3-14b": { input: 0.2, output: 0.2, cached: 0.02 },
  "ministral-3-8b": { input: 0.15, output: 0.15, cached: 0.015 },
  "ministral-3-3b": { input: 0.1, output: 0.1, cached: 0.01 },
  codestral: { input: 0.3, output: 0.9, cached: 0.03 },
  "codestral-embed": { input: 0.15, output: 0.0, cached: 0.015 },
  "mistral-embed": { input: 0.1, output: 0.0, cached: 0.01 },
};
export const ALIASES: Record<string, string> = {
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
  "ministral-3b-latest": "ministral-3-3b",
  "ministral-3b-2512": "ministral-3-3b",
  "ministral-8b-latest": "ministral-3-8b",
  "ministral-8b-2512": "ministral-3-8b",
  "ministral-14b-latest": "ministral-3-14b",
  "ministral-14b-2512": "ministral-3-14b",
  "glm-5-3": "zai-glm-5-3",
  "zai-glm-5": "zai-glm-5-3",
  "zai-glm-latest": "zai-glm-5-3",
  "codestral-latest": "codestral",
  "codestral-2508": "codestral",
};
export const FALLBACK: Price = { input: 0.7, output: 2.1, cached: 0.07 };
export const PRICES_PER_1K_PAGES_USD = { ocr: 4.0 };
export type PriceBook = {
  fx: number;
  prices: ReadonlyMap<string, Price>;
  lookup(model: string | null | undefined): [Price, boolean];
  costEur(model: string | null | undefined, prompt: number, completion: number, cached?: number): [number, boolean];
  pagesCostEur(pages: number): number;
};
export const createPriceBook = (usdToEur: number, overrides?: Record<string, PriceOverride>): PriceBook => {
  const prices = new Map(Object.entries(PRICES_USD));
  const aliases = new Map(Object.entries(ALIASES));
  for (const [model, p] of Object.entries(overrides ?? {}))
    prices.set(model, { input: p.input, output: p.output, cached: p.cached ?? null });
  const sortedKeys = [...prices.keys()].sort((a, b) => b.length - a.length);
  const lookup = (model: string | null | undefined): [Price, boolean] => {
    const m0 = (model ?? "").toLowerCase();
    const m = aliases.get(m0) ?? m0;
    const hit = prices.get(m);
    if (hit) return [hit, true];
    for (const key of sortedKeys) {
      if (m.startsWith(key)) {
        const p = prices.get(key);
        if (p) return [p, true];
      }
    }
    return [FALLBACK, false];
  };
  const costEur = (
    model: string | null | undefined,
    prompt: number,
    completion: number,
    cached = 0,
  ): [number, boolean] => {
    const [p, exact] = lookup(model);
    const c = Math.min(Math.max(cached, 0), prompt);
    const cachedPrice = p.cached ?? p.input;
    const usd = ((prompt - c) * p.input + c * cachedPrice + completion * p.output) / 1e6;
    return [usd * usdToEur, exact];
  };
  return {
    fx: usdToEur,
    prices,
    lookup,
    costEur,
    pagesCostEur: (pages) => (pages / 1000) * PRICES_PER_1K_PAGES_USD.ocr * usdToEur,
  };
};
