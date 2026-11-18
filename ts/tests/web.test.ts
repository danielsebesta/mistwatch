import { describe, expect, it, vi } from "vitest";
import { attrValue } from "../web/src/attr.ts";
import { latest, stepTab } from "../web/src/flow.ts";
import { pref } from "../web/src/state.ts";

describe("attrValue", () => {
  it("serialises ARIA booleans as strings", () => {
    expect(attrValue("aria-selected", true)).toBe("true");
    expect(attrValue("aria-selected", false)).toBe("false");
    expect(attrValue("aria-hidden", "true")).toBe("true");
  });
  it("treats other booleans as present or absent", () => {
    expect(attrValue("data-x", true)).toBe("");
    expect(attrValue("data-x", false)).toBeNull();
    expect(attrValue("title", null)).toBeNull();
    expect(attrValue("tabindex", 0)).toBe("0");
    expect(attrValue("onclick", () => {})).toBeNull();
  });
});

describe("latest", () => {
  it("only the newest ticket is current", () => {
    const g = latest();
    const old = g.next();
    const fresh = g.next();
    expect(g.isCurrent(old)).toBe(false);
    expect(g.isCurrent(fresh)).toBe(true);
  });
});

describe("stepTab", () => {
  it("wraps around in both directions", () => {
    expect(stepTab(3, 2, "ArrowRight")).toBe(0);
    expect(stepTab(3, 0, "ArrowLeft")).toBe(2);
    expect(stepTab(3, 1, "ArrowRight")).toBe(2);
  });
  it("ignores other keys", () => {
    expect(stepTab(3, 1, "Enter")).toBeNull();
    expect(stepTab(0, 0, "ArrowRight")).toBeNull();
  });
});

describe("pref", () => {
  it("falls back to the default when storage throws", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("localStorage", blocked);
    expect(pref.get("range", "7d")).toBe("7d");
    expect(() => pref.set("range", "30d")).not.toThrow();
    vi.unstubAllGlobals();
  });
});
