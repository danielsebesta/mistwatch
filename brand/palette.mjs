// Generates the dark Material You (M3) palette from one seed colour and writes it into the UI tokens.
//   cd brand && npm install && node palette.mjs [#seed]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Hct, SchemeVibrant, TonalPalette, argbFromHex, hexFromArgb } from "@material/material-color-utilities";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = process.argv[2] || "#ff8a1f";            // amber-orange
const seed = argbFromHex(SEED);
const scheme = new SchemeVibrant(Hct.fromInt(seed), true, 0);  // dark, standard contrast
const N = t => hexFromArgb(scheme.neutralPalette.tone(t));
const NV = t => hexFromArgb(scheme.neutralVariantPalette.tone(t));
const P = t => hexFromArgb(scheme.primaryPalette.tone(t));
// status and chart colours: fixed hues from M3 tonal palettes. They are deliberately NOT harmonised towards the
// orange seed (Blend.harmonize would drag green/red/yellow towards orange and blur their meaning).
const hue = (h, c, t) => hexFromArgb(TonalPalette.fromHueAndChroma(h, c).tone(t));

const T = {
  bg: N(6), surface: N(10), fill: N(17), "fill-2": N(22), line: N(22), "line-strong": NV(60),
  "text-3": NV(75), "text-2": NV(85), text: N(92),
  accent: P(75), "accent-ink": P(15),
  ok: hue(150, 46, 76), warn: hue(100, 62, 84), bad: hue(12, 72, 72),
  s1: P(72), s2: hue(200, 46, 72), s3: hue(255, 42, 78), s4: hue(140, 44, 72), s5: hue(350, 52, 76), s6: hue(105, 54, 80),
  "s-other": NV(45),
};
const css = Object.entries(T).map(([k, v]) => `  --${k}:${v};`).join("\n") +
  "\n  --accent-soft:color-mix(in srgb,var(--accent) 14%,var(--surface));" +
  "\n  --ok-soft:color-mix(in srgb,var(--ok) 14%,var(--surface));" +
  "\n  --warn-soft:color-mix(in srgb,var(--warn) 14%,var(--surface));" +
  "\n  --bad-soft:color-mix(in srgb,var(--bad) 14%,var(--surface));";

const file = join(here, "..", "src", "mistwatch", "web", "index.html");
let html = readFileSync(file, "utf8");
const nl = html.includes("\r\n") ? "\r\n" : "\n";
html = html.replace(/(\/\* TOKENS:BEGIN[^\r\n]*\*\/\r?\n)[\s\S]*?(  \/\* TOKENS:END \*\/)/, (_, a, b) => a + css.replace(/\n/g, nl) + nl + b)
  .replace(/<meta name="theme-color" content="#[0-9a-f]{6}">/, `<meta name="theme-color" content="${T.bg}">`);
writeFileSync(file, html);
writeFileSync(join(here, "palette.json"), JSON.stringify({ seed: SEED, tokens: T }, null, 2) + "\n");
console.log(Object.entries(T).map(([k, v]) => `${k.padEnd(12)} ${v}`).join("\n"));
