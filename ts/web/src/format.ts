export const enc = encodeURIComponent;
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
export const eur = (v: number | null | undefined): string =>
  `€${(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const eur4 = (v: number): string => (v < 0.01 ? `€${v.toFixed(5)}` : eur(v));
export const when = (ts: number | null | undefined): string =>
  ts
    ? new Date(ts * 1000).toLocaleString("en-GB", {
        day: "numeric",
        month: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
export const ago = (ts: number | null | undefined): string => {
  if (!ts) return "never";
  const s = Date.now() / 1000 - ts;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
export const pct100 = (v: number): number => Math.max(0, Math.min(100, v));
export const short = (v: number): string =>
  v >= 100
    ? `€${Math.round(v)}`
    : v >= 10
      ? `€${v.toFixed(0)}`
      : v >= 1
        ? `€${v.toFixed(1).replace(/\.0$/, "")}`
        : `€${v.toFixed(2)}`;
export const niceMax = (v: number): number => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 3, 5, 7.5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
};
export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
