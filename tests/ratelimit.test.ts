import { describe, expect, it } from "vitest";
import { createLoginLockout, createRateLimiter } from "../src/ratelimit.ts";

const mkClock = (start = 1000) => {
  let t = start;
  return { now: () => t, advance: (s: number) => (t += s) };
};
describe("rate limiter", () => {
  it("allows a burst up to limit, then rejects with retryAfter", () => {
    const c = mkClock();
    const rl = createRateLimiter({ limit: 3, windowS: 10, now: c.now });
    for (let i = 0; i < 3; i++) expect(rl.check("k").allowed).toBe(true);
    const r = rl.check("k");
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
    expect(r.retryAfter).toBeLessThanOrEqual(10 / 3 + 1e-9);
  });
  it("refills continuously over the window", () => {
    const c = mkClock();
    const rl = createRateLimiter({ limit: 4, windowS: 8, now: c.now }); // 0.5 token/s
    for (let i = 0; i < 4; i++) expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(false);
    c.advance(2); // +1 token
    expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(false);
    c.advance(100); // capped at limit, not unbounded accumulation
    for (let i = 0; i < 4; i++) expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(false);
  });
  it("keys are independent and cost is honoured", () => {
    const c = mkClock();
    const rl = createRateLimiter({ limit: 5, windowS: 10, now: c.now });
    expect(rl.check("a", 4).allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(false);
    expect(rl.check("b").allowed).toBe(true);
  });
  it("evicts the least recently used key at maxKeys", () => {
    const c = mkClock();
    const rl = createRateLimiter({ limit: 1, windowS: 60, maxKeys: 3, now: c.now });
    for (const k of ["a", "b", "c"]) expect(rl.check(k).allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(false); // denied, but refreshes recency
    expect(rl.check("d").allowed).toBe(true); // evicts b (the oldest untouched)
    expect(rl.size).toBe(3);
    expect(rl.check("c").allowed).toBe(false); // c's empty bucket survived
    expect(rl.check("a").allowed).toBe(false); // a's empty bucket survived
    expect(rl.check("b").allowed).toBe(true); // b was evicted: fresh full bucket
  });
  it("reset clears one key or everything", () => {
    const rl = createRateLimiter({ limit: 1, windowS: 60 });
    rl.check("a");
    rl.reset("a");
    expect(rl.check("a").allowed).toBe(true);
    rl.check("b");
    expect(rl.size).toBe(2);
    rl.reset();
    expect(rl.size).toBe(0);
  });
});
describe("login lockout", () => {
  it("locks after 5 failures for 60 s, keyed by user+addr", () => {
    const c = mkClock();
    const lo = createLoginLockout({ now: c.now });
    for (let i = 0; i < 4; i++) {
      expect(lo.fail("Ann", "1.2.3.4")).toBe(0);
      expect(lo.check("Ann", "1.2.3.4")).toBe(0);
    }
    expect(lo.fail("ann", "1.2.3.4")).toBe(60); // username matching is case-insensitive
    expect(lo.check("ANN", "1.2.3.4")).toBe(60);
    expect(lo.check("ann", "5.6.7.8")).toBe(0); // different address is not locked
    c.advance(59);
    expect(lo.check("ann", "1.2.3.4")).toBe(1);
    expect(lo.fail("ann", "1.2.3.4")).toBe(1); // fails during the lock do not extend it
    c.advance(2);
    expect(lo.check("ann", "1.2.3.4")).toBe(0);
  });
  it("success clears the counter", () => {
    const lo = createLoginLockout();
    for (let i = 0; i < 4; i++) lo.fail("u", "ip");
    lo.success("u", "ip");
    expect(lo.check("u", "ip")).toBe(0);
    expect(lo.fail("u", "ip")).toBe(0);
  });
  it("failure counter decays after the window", () => {
    const c = mkClock();
    const lo = createLoginLockout({ now: c.now, windowS: 300 });
    for (let i = 0; i < 4; i++) lo.fail("u", "ip");
    c.advance(301);
    expect(lo.fail("u", "ip")).toBe(0); // only 1 fresh fail, not the 5th
  });
  it("bounds memory at maxKeys", () => {
    const c = mkClock();
    const lo = createLoginLockout({ now: c.now, maxKeys: 3 });
    for (let i = 0; i < 3; i++) lo.fail(`u${i}`, "ip");
    lo.fail("u3", "ip");
    expect(lo.size).toBe(3);
  });
});
