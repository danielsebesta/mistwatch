import { asException, errors } from "./errors.ts";
export type Release = () => void;
export type Mutex = {
  acquire(signal?: AbortSignal): Promise<Release>;
  tryAcquire(): Release | null;
  readonly locked: boolean;
};
const abortReason = (signal: AbortSignal | undefined): unknown =>
  signal === undefined ? new DOMException("aborted", "AbortError") : signal.reason;
export const createMutex = (): Mutex => {
  type Waiter = { dead: boolean; ok: (r: Release) => void };
  const q: Waiter[] = [];
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
    for (;;) {
      const w = q.shift();
      if (w === undefined) {
        held = false;
        return;
      }
      if (!w.dead) {
        w.ok(releaseOnce());
        return;
      }
    }
  };
  const acquire = (signal?: AbortSignal): Promise<Release> => {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!held) {
      held = true;
      return Promise.resolve(releaseOnce());
    }
    return new Promise<Release>((ok, fail) => {
      const w: Waiter = { dead: false, ok };
      q.push(w);
      signal?.addEventListener(
        "abort",
        () => {
          w.dead = true;
          fail(abortReason(signal));
        },
        { once: true },
      );
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
  };
  const items: Item[] = [];
  let active = 0;
  const settle = (it: Item, succeeded: boolean, val: unknown): void => {
    if (it.done) return;
    it.done = true;
    if (it.timer !== undefined) clearTimeout(it.timer);
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
        it.done = true;
        if (it.timer !== undefined) clearTimeout(it.timer);
        it.fail(it.ctrl.signal.reason);
        continue;
      }
      // the timeout covers queueing too: never start work past its deadline
      if (it.deadline !== undefined && Date.now() >= it.deadline) {
        it.done = true;
        if (it.timer !== undefined) clearTimeout(it.timer);
        it.fail(asException(errors.queueTimeout()));
        continue;
      }
      it.running = true;
      active++;
      const sig = it.ctrl.signal;
      const aborted = new Promise<never>((_, rej) => {
        sig.addEventListener("abort", () => rej(sig.reason), { once: true });
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
      const it: Item = {
        fn,
        ok: (v) => ok(v as T),
        fail,
        ctrl: new AbortController(),
        timer: undefined,
        deadline: undefined,
        running: false,
        done: false,
      };
      it.ctrl.signal.addEventListener(
        "abort",
        () => {
          if (it.done || it.running) return;
          it.done = true;
          if (it.timer !== undefined) clearTimeout(it.timer);
          const i = items.indexOf(it);
          if (i >= 0) items.splice(i, 1);
          it.fail(it.ctrl.signal.reason);
        },
        { once: true },
      );
      const tmo = o.timeoutMs ?? opts.timeoutMs;
      if (tmo !== undefined) {
        it.deadline = Date.now() + tmo;
        it.timer = setTimeout(() => it.ctrl.abort(asException(errors.queueTimeout())), tmo);
      }
      const caller = o.signal;
      if (caller !== undefined) caller.addEventListener("abort", () => it.ctrl.abort(caller.reason), { once: true });
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
