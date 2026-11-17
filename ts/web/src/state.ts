import type { SessionUser } from "../../shared/api.ts";

export const session: { me: SessionUser | null; sumTimer: number } = { me: null, sumTimer: 0 };
type Handlers = { boot: () => Promise<void>; pause: () => void; resume: () => void; dispose: () => void };
const idle = (): void => {};
export const handlers: Handlers = { boot: async () => {}, pause: idle, resume: idle, dispose: idle };
// The active view registers its own hooks; navigating away disposes them.
export const disposeView = (): void => {
  handlers.dispose();
  handlers.pause = idle;
  handlers.resume = idle;
  handlers.dispose = idle;
};
export const pref = {
  get: (k: string, d: string): string => localStorage.getItem(`mw.${k}`) || d,
  set: (k: string, v: string): void => localStorage.setItem(`mw.${k}`, v),
};
