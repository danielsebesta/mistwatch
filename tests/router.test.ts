import { describe, expect, it } from "vitest";
import {
  apply,
  decide,
  decisionHeader,
  LADDER,
  SCORE_MAX,
  SCORE_TO_LEVEL,
  scoreRequest,
  VALID_EFFORT,
  worthAsking,
} from "../src/router.ts";
import type { ChatBody } from "../src/types.ts";

const d = (text: string, kw: Record<string, unknown> = {}) =>
  decide({ messages: [{ role: "user", content: text }], ...kw });
describe("router", () => {
  it("counts code points", () => {
    const r = d(`debug ${"😀".repeat(751)}`, { tools: [{}] });
    expect(r.score).toBe(8);
    expect(r.reason).toContain("long prompt");
    expect(r.model).toBe("mistral-large-4-0");
    expect(r.effort).toBe("low");
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
    expect(decide(body, 0.05).level).toBeLessThan(decide(body, 1.0).level);
  });
  it("apply rewrites the body and the client cannot set the effort", () => {
    const body: ChatBody = {
      messages: [{ role: "user", content: "debug refactor optimize analyze architecture ".repeat(80) }],
      reasoning_effort: "xx",
    };
    const r = decide(body);
    expect(r.reason).not.toContain("client effort");
    const out = apply(body, r);
    expect(out.model).toBe(r.model);
    expect(out.reasoning_effort).toBe(r.effort);
  });
  it("llm score blends and can raise the level", () => {
    const body: ChatBody = { messages: [{ role: "user", content: "Proč mi padá vlákno?" }] };
    const base = decide(body);
    const raised = decide(body, 1.0, 9);
    expect(raised.llm_score).toBe(9);
    expect(raised.level).toBeGreaterThan(base.level);
    expect(decisionHeader(raised)).toContain(";llm=9");
    expect(decide(body, 1.0, 0).level).toBeLessThanOrEqual(base.level);
  });
});
describe("parity", () => {
  it("sorts hard keywords by code point", () => {
    const hi = String.fromCodePoint(0x1d41a);
    const lo = String.fromCodePoint(0xfb01);
    const r = scoreRequest({ messages: [{ role: "user", content: `debug${lo} debug${hi} bug` }] });
    expect(r[1].join(";")).toContain(`['bug', 'debug${lo}', 'debug${hi}']`);
  });
  it("asks the tiny model about any non-blank request", () => {
    const ask = (s: string) => worthAsking({ messages: [{ role: "user", content: s }] });
    expect(ask("ahoj")).toBe(true);
    expect(ask(`  ${String.fromCharCode(0x1c)}${String.fromCharCode(0x85)} `)).toBe(false);
    expect(ask("")).toBe(false);
  });
  it("counts non-ascii digit list markers", () => {
    const fw = (n: number) => String.fromCodePoint(0xff10 + n);
    const r = d(`${fw(1)}. a ${fw(2)}. b ${fw(3)}. c`);
    expect(r.reason).toContain("multi-part");
  });
});
describe("auto routing", () => {
  const body: ChatBody = { messages: [{ role: "user", content: "x" }] };
  it("ignores the effort a client asks for", () => {
    const r = decide({ ...body, reasoning_effort: "max" }, 1.0, 5);
    expect(r.effort).toBe(LADDER[r.level]?.effort);
  });
  it("the tiny model alone sets the difficulty when it answers", () => {
    const hard = "debug refactor optimize analyze architecture ".repeat(80);
    const heavy: ChatBody = { messages: [{ role: "user", content: hard }], tools: [{}] };
    expect(decide(heavy, 1.0, 0).score).toBe(0);
    expect(decide(heavy).score).toBeGreaterThan(3);
  });
  it("takes the stronger step only when it is cheaper", () => {
    const five: ChatBody = { messages: [{ role: "user", content: "x" }] };
    const at3 = decide(five, 1.0, 12);
    expect(at3.model).toBe("mistral-large-4-0");
    const price = (m: string) =>
      m === "deepseek-v4-1-flash-1017" ? { input: 0.1, output: 0.4 } : { input: 2, output: 6 };
    const cheaper = decide(five, 1.0, 12, price);
    expect(cheaper.model).toBe("deepseek-v4-1-flash-1017");
    expect(cheaper.reason).toContain("stronger and cheaper");
    const dear = decide(five, 1.0, 12, (m) =>
      m === "deepseek-v4-1-flash-1017" ? { input: 5, output: 20 } : { input: 2, output: 6 },
    );
    expect(dear.model).toBe("mistral-large-4-0");
    expect(decide(five, 0.05, 12, price).reason).not.toContain("stronger and cheaper");
  });
});
describe("ladder", () => {
  it("uses GLM 5.3 only at max and keeps DeepSeek below it", () => {
    const glm = LADDER.filter((s) => s.model === "zai-glm-5-3");
    expect(glm.map((s) => s.effort)).toEqual(["max"]);
    expect(LADDER.findIndex((s) => s.model === "deepseek-v4-1-flash-1017")).toBeLessThan(
      LADDER.findIndex((s) => s.model === "zai-glm-5-3"),
    );
  });
});
describe("0-20 scale", () => {
  const body: ChatBody = { messages: [{ role: "user", content: "x" }] };
  it("covers every score with a step and every step with a score range", () => {
    expect(SCORE_MAX).toBe(20);
    expect(SCORE_TO_LEVEL.at(-1)?.[0]).toBe(20);
    expect(SCORE_TO_LEVEL.map(([, level]) => level)).toEqual(LADDER.map((_, i) => i));
    for (let s = 0; s <= 20; s++) expect(decide(body, 1.0, s).level).toBeGreaterThanOrEqual(0);
  });
  it("only uses efforts the model accepts", () => {
    for (const step of LADDER) expect(VALID_EFFORT[step.model]?.has(step.effort ?? "none")).toBe(true);
  });
  it("climbs with the score and clamps out-of-range ratings", () => {
    const levels = Array.from({ length: 21 }, (_, s) => decide(body, 1.0, s).level);
    expect([...levels].sort((a, b) => a - b)).toEqual(levels);
    expect(decide(body, 1.0, 99).level).toBe(decide(body, 1.0, 20).level);
    expect(decide(body, 1.0, 20).model).toBe("zai-glm-5-3");
  });
  it("uses GLM Flash at more than one effort", () => {
    expect(LADDER.filter((s) => s.model === "zai-glm-5-3-flash").map((s) => s.effort)).toEqual(["low", "high"]);
  });
});
