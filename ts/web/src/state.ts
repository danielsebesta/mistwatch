import type { SessionUser } from "../../shared/api.ts";

export const session: { me: SessionUser | null; timer: number; sumTimer: number } = { me: null, timer: 0, sumTimer: 0 };
export const handlers: { boot: () => Promise<void>; resume: () => void } = {
  boot: async () => {},
  resume: () => {},
};
export const pref = {
  get: (k: string, d: string): string => localStorage.getItem(`mw.${k}`) || d,
  set: (k: string, v: string): void => localStorage.setItem(`mw.${k}`, v),
};
