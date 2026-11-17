import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAppError } from "../src/errors.ts";
import { createKeyedMutex, createMutex, createQueue, createReservationLedger } from "../src/queue.ts";

const deferred = <T>() => {
  let ok: (v: T) => void = () => undefined;
  let fail: (e: unknown) => void = () => undefined;
  const p = new Promise<T>((o, f) => {
    ok = o;
    fail = f;
  });
  return { p, ok, fail };
};
describe("mutex", () => {
  it("serialises holders in fifo order", async () => {
    const m = createMutex();
    const order: string[] = [];
    const r1 = await m.acquire();
    const d2 = deferred<void>();
    const d3 = deferred<void>();
    const p2 = m.acquire().then((r) =>
      d2.p.then(() => {
        order.push("two");
        r();
      }),
    );
    const p3 = m.acquire().then((r) =>
      d3.p.then(() => {
        order.push("three");
        r();
      }),
    );
    r1();
    order.push("one");
    d3.ok(); // three's gate opens first, but two holds the fifo slot
    await Promise.resolve();
    d2.ok();
    await Promise.all([p2, p3]);
    expect(order).toEqual(["one", "two", "three"]);
    expect(m.locked).toBe(false);
  });
  it("release is idempotent", async () => {
    const m = createMutex();
    const r = await m.acquire();
    r();
    r();
    expect(m.locked).toBe(false);
    const r2 = await m.acquire();
    r2();
  });
  it("tryAcquire returns null while held", async () => {
    const m = createMutex();
    const r = m.tryAcquire();
    expect(r).not.toBeNull();
    expect(m.tryAcquire()).toBeNull();
    r?.();
    expect(m.tryAcquire()).not.toBeNull();
  });
  it("abort while waiting rejects and frees the slot for others", async () => {
    const m = createMutex();
    const r1 = await m.acquire();
    const ctrl = new AbortController();
    const waiting = m.acquire(ctrl.signal);
    ctrl.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    r1();
    const r2 = await m.acquire();
    r2();
  });
  it("acquire on an already-aborted signal rejects without holding", async () => {
    const m = createMutex();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(m.acquire(ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(m.locked).toBe(false);
    const r = await m.acquire();
    r();
  });
  it("removes the abort listener when a waiter is granted or dropped", async () => {
    const m = createMutex();
    const r1 = await m.acquire();
    const c1 = new AbortController();
    const p = m.acquire(c1.signal);
    expect(getEventListeners(c1.signal, "abort").length).toBe(1);
    r1();
    const r2 = await p;
    expect(getEventListeners(c1.signal, "abort").length).toBe(0);
    const c2 = new AbortController();
    const dropped = m.acquire(c2.signal);
    c2.abort();
    await expect(dropped).rejects.toMatchObject({ name: "AbortError" });
    expect(getEventListeners(c2.signal, "abort").length).toBe(0);
    r2();
  });
  it("drops aborted waiters instead of accumulating them", async () => {
    const m = createMutex();
    const r = await m.acquire();
    const cs = Array.from({ length: 4 }, () => new AbortController());
    const ps = cs.map((c) => m.acquire(c.signal));
    expect(m.pending).toBe(4);
    for (const c of cs) c.abort();
    expect(m.pending).toBe(0);
    for (const p of ps) await expect(p).rejects.toMatchObject({ name: "AbortError" });
    r();
    const r2 = await m.acquire();
    r2();
  });
});
describe("keyed mutex", () => {
  it("serialises per key, parallel across keys, cleans up", async () => {
    const km = createKeyedMutex();
    const ra = await km.acquire("a");
    const rb = await km.acquire("b"); // different key: immediate
    let done = false;
    const pa = km.acquire("a").then((r) => {
      done = true;
      return r;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    rb();
    ra();
    const ra2 = await pa;
    expect(done).toBe(true);
    ra2();
    expect(km.size).toBe(0);
  });
});
describe("bounded queue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("never exceeds concurrency and stays fifo", async () => {
    const q = createQueue({ concurrency: 2, maxPending: 10 });
    let running = 0;
    let maxSeen = 0;
    const done: number[] = [];
    const gate = deferred<void>();
    const jobs = Array.from({ length: 6 }, (_, i) =>
      q.run(async () => {
        running++;
        maxSeen = Math.max(maxSeen, running);
        await gate.p;
        running--;
        done.push(i);
        return i;
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(q.active).toBe(2);
    expect(q.pending).toBe(4);
    gate.ok();
    const results = await Promise.all(jobs);
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxSeen).toBe(2);
    expect(done).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it("rejects over maxPending with a typed queue-full error", async () => {
    const q = createQueue({ concurrency: 1, maxPending: 1 });
    const gate = deferred<number>();
    const p1 = q.run(() => gate.p);
    const p2 = q.run(() => 1);
    await expect(q.run(() => 2)).rejects.toMatchObject({ code: "mistwatch_queue_full", status: 503 });
    gate.ok(0);
    await expect(p1).resolves.toBe(0);
    await expect(p2).resolves.toBe(1);
  });
  it("rejects an already-aborted caller signal", async () => {
    const q = createQueue({ concurrency: 1, maxPending: 1 });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(q.run(() => 1, { signal: ctrl.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
  it("caller abort removes a pending item and aborts a running one", async () => {
    const q = createQueue({ concurrency: 1, maxPending: 5 });
    const gate1 = deferred<void>();
    const gate2 = deferred<void>();
    const p1 = q.run(() => gate1.p);
    const cPending = new AbortController();
    const p2 = q.run(() => 2, { signal: cPending.signal });
    const e2 = expect(p2).rejects.toMatchObject({ name: "AbortError" });
    cPending.abort();
    await e2;
    expect(q.pending).toBe(0);
    const cRunning = new AbortController();
    let sawAbort = false;
    const p3 = q.run(
      async (sig) => {
        sig.addEventListener("abort", () => (sawAbort = true), { once: true });
        await gate2.p;
        return 3;
      },
      { signal: cRunning.signal },
    );
    const p4 = q.run(() => 4);
    gate1.ok();
    await expect(p1).resolves.toBeUndefined();
    for (let i = 0; i < 10; i++) await Promise.resolve(); // let p3 reach running
    const e3 = expect(p3).rejects.toMatchObject({ name: "AbortError" });
    cRunning.abort();
    await e3;
    expect(sawAbort).toBe(true);
    await expect(p4).resolves.toBe(4); // slot freed for the next item
    expect(q.active).toBe(0);
    gate2.ok(); // nothing depends on it: p3's detached fn may still settle
  });
  it("per-item timeout aborts the signal and rejects", async () => {
    const q = createQueue({ concurrency: 1, maxPending: 5 });
    let aborted = false;
    const p = q.run(
      async (sig) => {
        sig.addEventListener("abort", () => (aborted = true), { once: true });
        await new Promise(() => {}); // never settles on its own
      },
      { timeoutMs: 50 },
    );
    const e = expect(p).rejects.toMatchObject({ code: "mistwatch_queue_timeout", status: 503 });
    await vi.advanceTimersByTimeAsync(50);
    await e;
    expect(aborted).toBe(true);
    expect(q.active).toBe(0);
    await expect(q.run(() => "ok")).resolves.toBe("ok");
  });
  it("default timeoutMs covers the whole wait too", async () => {
    const q = createQueue({ concurrency: 1, maxPending: 5, timeoutMs: 100 });
    const gate = deferred<void>();
    const p1 = q.run(() => gate.p); // running: times out mid-flight
    const e1 = expect(p1).rejects.toMatchObject({ code: "mistwatch_queue_timeout" });
    const p2 = q.run(() => 2); // pending: expires without ever starting
    const e2 = expect(p2).rejects.toMatchObject({ code: "mistwatch_queue_timeout" });
    await vi.advanceTimersByTimeAsync(100);
    await e1;
    await e2;
    gate.ok();
  });
  it("propagates fn errors", async () => {
    const q = createQueue({ concurrency: 1, maxPending: 1 });
    await expect(q.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
  it("detaches the caller abort listener once an item settles", async () => {
    const q = createQueue({ concurrency: 1, maxPending: 5 });
    const c = new AbortController();
    await q.run(() => 1, { signal: c.signal });
    expect(getEventListeners(c.signal, "abort").length).toBe(0);
    const c2 = new AbortController();
    const gate = deferred<void>();
    const p = q.run(() => gate.p, { signal: c2.signal });
    expect(getEventListeners(c2.signal, "abort").length).toBe(1);
    gate.ok();
    await p;
    expect(getEventListeners(c2.signal, "abort").length).toBe(0);
  });
  it("drops aborted pending items synchronously and frees their listeners", async () => {
    const q = createQueue({ concurrency: 1, maxPending: 10 });
    const gate = deferred<void>();
    const p1 = q.run(() => gate.p);
    const cs = Array.from({ length: 4 }, () => new AbortController());
    const ps = cs.map((c) => q.run(() => 0, { signal: c.signal }));
    expect(q.pending).toBe(4);
    for (const c of cs) c.abort();
    expect(q.pending).toBe(0);
    for (const p of ps) await expect(p).rejects.toMatchObject({ name: "AbortError" });
    for (const c of cs) expect(getEventListeners(c.signal, "abort").length).toBe(0);
    gate.ok();
    await p1;
    expect(q.active).toBe(0);
  });
});
describe("reservation ledger", () => {
  it("reserve/release/settle each work exactly once", () => {
    const l = createReservationLedger();
    const r = l.reserve("k", 5);
    expect(l.outstanding("k")).toBe(5);
    r.release();
    r.release();
    r.settle();
    expect(l.outstanding("k")).toBe(0);
    expect(r.done).toBe(true);
    const r2 = l.reserve("k", 3);
    r2.settle();
    r2.settle();
    expect(l.outstanding("k")).toBe(0);
  });
  it("tryReserve enforces the limit atomically", () => {
    const l = createReservationLedger();
    expect(l.tryReserve("k", 4, 10)).not.toBeNull();
    expect(l.tryReserve("k", 7, 10)).toBeNull();
    expect(l.outstanding("k")).toBe(4);
  });
  it("interleaved async holds settle to zero without drift", async () => {
    const l = createReservationLedger();
    const gate = deferred<void>();
    const all = Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        (async () => {
          const r = l.reserve("acct/pool", i + 1);
          await gate.p;
          if (i % 3 === 0) r.release();
          else r.settle();
        })(),
      ),
    );
    expect(l.outstanding("acct/pool")).toBe(1275); // all 50 holds landed before any settle
    gate.ok();
    await all;
    expect(l.outstanding("acct/pool")).toBe(0);
    expect(l.outstanding()).toBe(0);
  });
  it("rejects invalid amounts", () => {
    const l = createReservationLedger();
    expect(() => l.reserve("k", -1)).toThrow(TypeError);
    expect(() => l.reserve("k", Number.NaN)).toThrow(TypeError);
  });
  it("queue-full rejection is an AppError", async () => {
    const q = createQueue({ concurrency: 1, maxPending: 0 });
    await expect(q.run(() => 1).catch((e: unknown) => isAppError(e))).resolves.toBe(true);
  });
});
