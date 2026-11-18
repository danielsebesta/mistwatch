import type { SessionUser } from "../../shared/api.ts";

export const session: { me: SessionUser | null; sumTimer: number } = { me: null, sumTimer: 0 };
// boot resolves to an error message when the session could not be loaded
type Handlers = { boot: () => Promise<string | null>; pause: () => void; resume: () => void; dispose: () => void };
const idle = (): void => {};
export const handlers: Handlers = { boot: async () => null, pause: idle, resume: idle, dispose: idle };
// The active view registers its own hooks; navigating away disposes them.
export const disposeView = (): void => {
  handlers.dispose();
  handlers.pause = idle;
  handlers.resume = idle;
  handlers.dispose = idle;
};
// Storage can be blocked or full; preferences are optional.
export const pref = {
  get: (k: string, d: string): string => {
    try {
      return localStorage.getItem(`mw.${k}`) || d;
    } catch {
      return d;
    }
  },
  set: (k: string, v: string): void => {
    try {
      localStorage.setItem(`mw.${k}`, v);
    } catch {
      // not persisted
    }
  },
};
