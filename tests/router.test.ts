import { describe, expect, it } from "vitest";
import { apply, decide, decisionHeader, scoreRequest, worthAsking } from "../src/router.ts";
import type { ChatBody } from "../src/types.ts";

const d = (text: string, kw: Record<string, unknown> = {}) =>
  decide({ messages: [{ role: "user", content: text }], ...kw });
describe("router", () => {
  it("counts code points", () => {
    const r = d(`debug ${"😀".repeat(751)}`, { tools: [{}] });
    expect(r.score).toBe(4);
    expect(r.reason).toContain("long prompt");
    expect(r.model).toBe("mistral-large-4-0");
    expect(r.effort).toBe("medium");
    expect(scoreRequest({ messages: [{ role: "user", content: "😀".repeat(400) }] })[2]).toBe(100);
  });
  it("trivial goes small", () => {
    const r = d("ahoj");
    expect(r.model).toBe("mistral-small-2603");
    expect(r.effort).toBe("none");
  });
  it("hard debugging goes up the ladder", () => {
    const r = d(
      "Debug this race condition and refactor the architecture, think carefully:\n```py\nx=1\n```\nTraceback (most recent call last):\n  File x",
    );
    expect(r.level).toBeGreaterThanOrEqual(3);
  });
  it("tools and agent use large", () => {
    const body: ChatBody = {
      messages: [{ role: "user", content: "Implement the migration and fix the bug in the parser" }],
      tools: [{}],
    };
    expect(["mistral-large-4-0", "zai-glm-5-3"]).toContain(decide(body).model);
  });
  it("images never go to GLM 5.3", () => {
    const body: ChatBody = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "debug refactor optimize analyze this design ".repeat(40) },
            { type: "image_url", image_url: "x" },
          ],
        },
      ],
    };
    expect(decide(body).model).not.toBe("zai-glm-5-3");
  });
  it("budget pressure only downgrades", () => {
    const body: ChatBody = {
      messages: [{ role: "user", content: "Implement and optimize and debug this algorithm carefully ".repeat(20) }],
    };
    expect(decide(body, "auto", 0.05).level).toBeLessThan(decide(body, "auto", 1.0).level);
  });
  it("auto-fast caps the ladder and apply rewrites the body", () => {
    const body: ChatBody = {
      messages: [{ role: "user", content: "debug refactor optimize analyze architecture ".repeat(80) }],
      reasoning_effort: "xx",
    };
    const r = decide(body, "auto-fast");
    expect(r.level).toBeLessThanOrEqual(2);
    const out = apply(body, r);
    expect(out.model).toBe(r.model);
    expect(out.reasoning_effort).toBe(r.effort);
  });
  it("llm score blends and can raise the level", () => {
    const body: ChatBody = { messages: [{ role: "user", content: "Proč mi padá vlákno?" }] };
    const base = decide(body);
    const raised = decide(body, "auto", 1.0, 9);
    expect(raised.llm_score).toBe(9);
    expect(raised.level).toBeGreaterThan(base.level);
    expect(decisionHeader(raised)).toContain(";llm=9");
    expect(decide(body, "auto", 1.0, 0).level).toBeLessThanOrEqual(base.level);
  });
});
describe("parity", () => {
  it("sorts hard keywords by code point", () => {
    const hi = String.fromCodePoint(0x1d41a);
    const lo = String.fromCodePoint(0xfb01);
    const r = scoreRequest({ messages: [{ role: "user", content: `debug${lo} debug${hi} bug` }] });
    expect(r[1].join(";")).toContain(`['bug', 'debug${lo}', 'debug${hi}']`);
  });
  it("strips like str.strip in worthAsking", () => {
    const ask = (s: string) => worthAsking({ messages: [{ role: "user", content: s }] }, 0);
    expect(ask("x".repeat(29) + String.fromCharCode(0x1c))).toBe(false);
    expect(ask("x".repeat(29) + String.fromCharCode(0x85))).toBe(false);
    expect(ask("x".repeat(29) + String.fromCharCode(0xfeff))).toBe(true);
  });
  it("counts non-ascii digit list markers", () => {
    const fw = (n: number) => String.fromCodePoint(0xff10 + n);
    const r = d(`${fw(1)}. a ${fw(2)}. b ${fw(3)}. c`);
    expect(r.reason).toContain("multi-part");
  });
});
