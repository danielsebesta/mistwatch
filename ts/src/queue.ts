import { asException, errors } from "./errors.ts";
export type Release = () => void;
export type Mutex = {
  acquire(signal?: AbortSignal): Promise<Release>;
  tryAcquire(): Release | null;
  readonly locked: boolean;
  readonly pending: number;
};
const abortReason = (signal: AbortSignal | undefined): unknown =>
  signal === undefined ? new DOMException("aborted", "AbortError") : signal.reason;
export const createMutex = (): Mutex => {
  const q: ((r: Release) => void)[] = [];
  let held = false;
  const releaseOnce = (): Release => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      pump();
    };
  };
  const pump = (): void => {
    const next = q.shift();
    if (next === undefined) {
      held = false;
      return;
    }
    next(releaseOnce());
  };
  const acquire = (signal?: AbortSignal): Promise<Release> => {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!held) {
      held = true;
      return Promise.resolve(releaseOnce());
    }
    return new Promise<Release>((ok, fail) => {
      const grant = (r: Release): void => {
        signal?.removeEventListener("abort", onAbort);
        ok(r);
      };
      const onAbort = (): void => {
        const i = q.indexOf(grant);
        if (i >= 0) q.splice(i, 1);
        fail(abortReason(signal));
      };
      q.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
  return {
    acquire,
    tryAcquire: (): Release | null => {
      if (held) return null;
      held = true;
      return releaseOnce();
    },
    get locked() {
      return held;
    },
    get pending() {
      return q.length;
    },
  };
};
export type KeyedMutex = {
  acquire(key: string, signal?: AbortSignal): Promise<Release>;
  readonly size: number;
};
export const createKeyedMutex = (maxKeys = 1024): KeyedMutex => {
  const map = new Map<string, Mutex>();
  const acquire = async (key: string, signal?: AbortSignal): Promise<Release> => {
    let m = map.get(key);
    if (m === undefined) {
      m = createMutex();
      if (map.size >= maxKeys) {
        for (const [k, v] of map) {
          if (!v.locked) {
            map.delete(k);
            break;
          }
        }
      }
      map.set(key, m);
    }
    const rel = await m.acquire(signal);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      rel();
      if (map.get(key) === m && !m.locked) map.delete(key);
    };
  };
  return {
    acquire,
    get size() {
      return map.size;
    },
  };
};
export type QueueOpts = { concurrency: number; maxPending: number; timeoutMs?: number | undefined };
export type QueueRunOpts = { signal?: AbortSignal | undefined; timeoutMs?: number | undefined };
export type Queue = {
  run<T>(fn: (signal: AbortSignal) => T | Promise<T>, opts?: QueueRunOpts): Promise<T>;
  readonly pending: number;
  readonly active: number;
};
export const createQueue = (opts: QueueOpts): Queue => {
  const conc = Math.max(1, Math.floor(opts.concurrency));
  const maxP = Math.max(0, Math.floor(opts.maxPending));
  type Item = {
    fn: (signal: AbortSignal) => unknown;
    ok: (v: unknown) => void;
    fail: (e: unknown) => void;
    ctrl: AbortController;
    timer: ReturnType<typeof setTimeout> | undefined;
    deadline: number | undefined;
    running: boolean;
    done: boolean;
    onAbort: (() => void) | undefined;
    cleanup: () => void;
  };
  const items: Item[] = [];
  let active = 0;
  const drop = (it: Item, e: unknown): void => {
    it.done = true;
    it.cleanup();
    const i = items.indexOf(it);
    if (i >= 0) items.splice(i, 1);
    it.fail(e);
  };
  const settle = (it: Item, succeeded: boolean, val: unknown): void => {
    if (it.done) return;
    it.done = true;
    it.cleanup();
    active--;
    if (succeeded) it.ok(val);
    else it.fail(val);
    pump();
  };
  const pump = (): void => {
    while (active < conc) {
      const it = items.shift();
      if (it === undefined) return;
      if (it.ctrl.signal.aborted) {
        drop(it, it.ctrl.signal.reason);
        continue;
      }
      // the timeout covers queueing too: never start work past its deadline
      if (it.deadline !== undefined && Date.now() >= it.deadline) {
        drop(it, asException(errors.queueTimeout()));
        continue;
      }
      it.running = true;
      active++;
      const sig = it.ctrl.signal;
      const aborted = new Promise<never>((_, rej) => {
        it.onAbort = () => rej(sig.reason);
        sig.addEventListener("abort", it.onAbort, { once: true });
      });
      Promise.race([Promise.resolve().then(() => it.fn(sig)), aborted]).then(
        (v) => settle(it, true, v),
        (e) => settle(it, false, e),
      );
    }
  };
  const run = <T>(fn: (signal: AbortSignal) => T | Promise<T>, o: QueueRunOpts = {}): Promise<T> => {
    if (o.signal?.aborted) return Promise.reject(o.signal.reason);
    if (items.length >= maxP) return Promise.reject(asException(errors.queueFull()));
    return new Promise<T>((ok, fail) => {
      const caller = o.signal;
      const onCallerAbort = (): void => it.ctrl.abort(caller?.reason);
      const it: Item = {
        fn,
        ok: (v) => ok(v as T),
        fail,
        ctrl: new AbortController(),
        timer: undefined,
        deadline: undefined,
        running: false,
        done: false,
        onAbort: undefined,
        cleanup: () => {
          if (it.timer !== undefined) clearTimeout(it.timer);
          if (caller !== undefined) caller.removeEventListener("abort", onCallerAbort);
          it.ctrl.signal.removeEventListener("abort", onCtrlAbort);
          if (it.onAbort !== undefined) it.ctrl.signal.removeEventListener("abort", it.onAbort);
        },
      };
      const onCtrlAbort = (): void => {
        if (it.done || it.running) return;
        drop(it, it.ctrl.signal.reason);
      };
      it.ctrl.signal.addEventListener("abort", onCtrlAbort, { once: true });
      const tmo = o.timeoutMs ?? opts.timeoutMs;
      if (tmo !== undefined) {
        it.deadline = Date.now() + tmo;
        it.timer = setTimeout(() => it.ctrl.abort(asException(errors.queueTimeout())), tmo);
      }
      if (caller !== undefined) caller.addEventListener("abort", onCallerAbort, { once: true });
      items.push(it);
      pump();
    });
  };
  return {
    run,
    get pending() {
      return items.length;
    },
    get active() {
      return active;
    },
  };
};
export type Reservation = {
  readonly amount: number;
  readonly done: boolean;
  release(): void;
  settle(): void;
};
export type ReservationLedger = {
  reserve(key: string, amount: number): Reservation;
  tryReserve(key: string, amount: number, limit: number): Reservation | null;
  outstanding(key?: string): number;
};
export const createReservationLedger = (): ReservationLedger => {
  const holds = new Map<string, number>();
  const reserve = (key: string, amount: number): Reservation => {
    if (!Number.isFinite(amount) || amount < 0) throw new TypeError("reservation amount must be >= 0");
    holds.set(key, (holds.get(key) ?? 0) + amount);
    let done = false;
    const drop = (): void => {
      if (done) return;
      done = true;
      const left = (holds.get(key) ?? 0) - amount;
      if (left <= 1e-9) holds.delete(key);
      else holds.set(key, left);
    };
    return {
      amount,
      release: drop,
      settle: drop,
      get done() {
        return done;
      },
    };
  };
  return {
    reserve,
    tryReserve: (key, amount, limit) => ((holds.get(key) ?? 0) + amount > limit ? null : reserve(key, amount)),
    outstanding: (key) => {
      if (key !== undefined) return holds.get(key) ?? 0;
      let s = 0;
      for (const v of holds.values()) s += v;
      return s;
    },
  };
};
