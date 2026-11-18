import { describe, expect, it } from "vitest";
import { createPriceBook, FALLBACK } from "../src/pricing.ts";

describe("price overrides", () => {
  it("an override for an alias name wins over the alias target", () => {
    const pb = createPriceBook(1, { "mistral-small-latest": { input: 9, output: 10 } });
    expect(pb.lookup("mistral-small-latest")).toEqual([{ input: 9, output: 10, cached: null }, true]);
    expect(pb.lookup("Mistral-Small-4")[0].input).toBe(0.15);
  });
  it("aliases still resolve without an override", () => {
    expect(createPriceBook(1).lookup("mistral-small-latest")[0].input).toBe(0.15);
  });
});

describe("price lookup with prototype-named models", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("%s falls back as an unknown model", (name) => {
    const pb = createPriceBook(1);
    expect(pb.lookup(name)).toEqual([FALLBACK, false]);
    const [eur, exact] = pb.costEur(name, 1000, 100);
    expect(exact).toBe(false);
    expect(eur).toBeCloseTo((1000 * FALLBACK.input + 100 * FALLBACK.output) / 1e6, 12);
  });
  it("accepts overrides named like prototype members", () => {
    const overrides = JSON.parse('{"__proto__":{"input":1,"output":2},"constructor":{"input":3,"output":4}}');
    const pb = createPriceBook(1, overrides);
    expect(pb.lookup("__proto__")).toEqual([{ input: 1, output: 2, cached: null }, true]);
    expect(pb.lookup("constructor")[0].input).toBe(3);
  });
});
