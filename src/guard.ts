import { asException, errors } from "./errors.ts";
import { createLoginLockout, createRateLimiter, type LoginLockout, type RateLimiter } from "./ratelimit.ts";

// Checks that run before any database lookup: a per-IP request budget and a lock after repeated wrong keys.
export type Guard = {
  readonly ip: RateLimiter;
  readonly keyFails: LoginLockout;
  before(ip: string): void;
  wrongKey(ip: string): void;
  rightKey(ip: string): void;
};
export type GuardOpts = { ipRate?: [number, number]; maxKeyFails?: number; lockS?: number };
export const createGuard = (o: GuardOpts = {}): Guard => {
  const [lim, win] = o.ipRate ?? [600, 60];
  const ip = createRateLimiter({ limit: lim, windowS: win, maxKeys: 16384 });
  const keyFails = createLoginLockout({
    maxFails: o.maxKeyFails ?? 10,
    lockS: o.lockS ?? 60,
    windowS: 60,
    maxKeys: 16384,
  });
  return {
    ip,
    keyFails,
    before: (addr) => {
      const left = keyFails.check("key", addr);
      if (left > 0) throw asException(errors.locked(left));
      const r = ip.check(addr);
      if (!r.allowed) throw asException(errors.rateLimited(r.retryAfter));
    },
    wrongKey: (addr) => void keyFails.fail("key", addr),
    rightKey: (addr) => keyFails.success("key", addr),
  };
};
