export type Clock = () => number;
export type LimitResult = { allowed: boolean; retryAfter: number };
export type RateLimiterOpts = {
  limit: number;
  windowS: number;
  maxKeys?: number | undefined;
  now?: Clock | undefined;
};
export type RateLimiter = {
  check(key: string, cost?: number): LimitResult;
  reset(key?: string): void;
  readonly size: number;
};
export const createRateLimiter = (opts: RateLimiterOpts): RateLimiter => {
  const limit = Math.max(opts.limit, 0);
  const windowS = Math.max(opts.windowS, 0.001);
  const maxKeys = Math.max(opts.maxKeys ?? 4096, 1);
  const now = opts.now ?? (() => Date.now() / 1000);
  const rate = limit / windowS;
  const buckets = new Map<string, { tokens: number; at: number }>();
  const evict = (): void => {
    const oldest = buckets.keys().next();
    if (!oldest.done) buckets.delete(oldest.value);
  };
  const check = (key: string, cost = 1): LimitResult => {
    const t = now();
    let b = buckets.get(key);
    if (b === undefined) {
      if (buckets.size >= maxKeys) evict();
      b = { tokens: limit, at: t };
    } else {
      buckets.delete(key);
      b.tokens = Math.min(limit, b.tokens + (t - b.at) * rate);
      b.at = t;
    }
    buckets.set(key, b);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, retryAfter: 0 };
    }
    return { allowed: false, retryAfter: (cost - b.tokens) / rate };
  };
  return {
    check,
    reset: (key) => {
      if (key === undefined) buckets.clear();
      else buckets.delete(key);
    },
    get size() {
      return buckets.size;
    },
  };
};
export type LockoutOpts = {
  maxFails?: number | undefined;
  lockS?: number | undefined;
  windowS?: number | undefined;
  maxKeys?: number | undefined;
  now?: Clock | undefined;
};
export type LoginLockout = {
  check(user: string, addr: string): number;
  fail(user: string, addr: string): number;
  success(user: string, addr: string): void;
  readonly size: number;
};
export const createLoginLockout = (o: LockoutOpts = {}): LoginLockout => {
  const maxFails = Math.max(o.maxFails ?? 5, 1);
  const lockS = o.lockS ?? 60;
  const windowS = o.windowS ?? 600;
  const maxKeys = Math.max(o.maxKeys ?? 8192, 1);
  const now = o.now ?? (() => Date.now() / 1000);
  const entries = new Map<string, { fails: number[]; until: number }>();
  const keyOf = (user: string, addr: string): string => `${addr}|${user.toLowerCase()}`;
  const entry = (k: string): { fails: number[]; until: number } => {
    let e = entries.get(k);
    if (e === undefined) {
      if (entries.size >= maxKeys) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      e = { fails: [], until: 0 };
    } else {
      entries.delete(k);
    }
    entries.set(k, e);
    return e;
  };
  const check = (user: string, addr: string): number => {
    const e = entries.get(keyOf(user, addr));
    const t = now();
    return e !== undefined && e.until > t ? Math.ceil(e.until - t) : 0;
  };
  const fail = (user: string, addr: string): number => {
    const t = now();
    const e = entry(keyOf(user, addr));
    if (e.until > t) return Math.ceil(e.until - t);
    e.fails = e.fails.filter((ts) => t - ts < windowS);
    e.fails.push(t);
    if (e.fails.length >= maxFails) {
      e.until = t + lockS;
      e.fails = [];
      return Math.ceil(lockS);
    }
    return 0;
  };
  const success = (user: string, addr: string): void => {
    entries.delete(keyOf(user, addr));
  };
  return {
    check,
    fail,
    success,
    get size() {
      return entries.size;
    },
  };
};
