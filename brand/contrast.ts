// WCAG contrast check of the UI tokens (dark only). Run: npx tsx brand/contrast.ts [-v]. Exit code 1 on failure.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const T = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "palette.json"), "utf8"))
  .tokens as Record<string, string>;
const tok = (k: string): string => T[k] as string;

const channels = (h: string): number[] => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
const lum = (h: string): number => {
  const c = channels(h).map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
};
const cr = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
const mix = (a: string, b: string, p: number): string => {
  const A = channels(a);
  const B = channels(b);
  return `#${A.map((x, i) => Math.round(x * p + (B[i] as number) * (1 - p)).toString(16).padStart(2, "0")).join("")}`;
};

const surf = tok("surface");
const bg = tok("bg");
const fill = tok("fill");
const checks: [string, string, string, number][] = [];
for (const fg of ["text", "text-2", "text-3", "accent", "ok", "warn", "bad"])
  for (const [n, b] of [["surface", surf], ["bg", bg], ["fill", fill]] as const) checks.push([`${fg} on ${n}`, tok(fg), b, 4.5]);
for (const k of ["ok", "warn", "bad", "accent"]) checks.push([`${k} on ${k}-soft badge`, tok(k), mix(tok(k), surf, 0.14), 4.5]);
checks.push(
  ["accent-ink on accent (primary button)", tok("accent-ink"), tok("accent"), 4.5],
  ["surface on bad (solid danger, toast)", surf, tok("bad"), 4.5],
  ["bg on text (tooltip, toast)", bg, tok("text"), 4.5],
  ["text-3 on accent-soft", tok("text-3"), mix(tok("accent"), surf, 0.14), 4.5],
  ["accent focus ring on surface", tok("accent"), surf, 3.0],
);
for (const [n, b] of [["surface", surf], ["bg", bg], ["fill", fill]] as const)
  checks.push([`line-strong control border on ${n}`, tok("line-strong"), b, 3.0]);
for (let i = 1; i <= 6; i++) checks.push([`series s${i} on surface`, tok(`s${i}`), surf, 3.0]);

let bad = 0;
for (const [n, f, b, m] of checks) {
  const r = cr(f, b);
  if (r < m) bad++;
  if (r < m || process.argv.includes("-v")) console.log(`${r < m ? "FAIL" : "ok  "} ${n}: ${r.toFixed(2)} (need ${m})`);
}
console.log("fails:", bad);
process.exit(bad ? 1 : 0);
