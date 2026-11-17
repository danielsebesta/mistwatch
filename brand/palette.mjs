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

const E = t => hexFromArgb(scheme.errorPalette.tone(t));
// Exact M3 dark-scheme roles (tone numbers from the M3 spec). CSS variable names are kept; comments give the M3 role.
const T = {
  bg: N(6),                 // surface
  surface: N(12),           // surfaceContainer
  fill: N(17),              // surfaceContainerHigh
  "fill-2": N(22),          // surfaceContainerHighest
  line: NV(30),             // outlineVariant
  "line-strong": NV(60),    // outline
  "text-3": NV(80),         // onSurfaceVariant
  "text-2": N(90),          // onSurface
  text: N(90),              // onSurface
  accent: P(80),            // primary
  "accent-ink": P(20),      // onPrimary
  "accent-container": P(30),// primaryContainer
  ok: hue(150, 46, 80), warn: hue(100, 62, 80), bad: E(80),                    // extended colours + error
  "ok-container": hue(150, 46, 30), "warn-container": hue(100, 62, 30), "bad-container": E(30), // *Container
  s1: P(72), s2: hue(200, 46, 72), s3: hue(255, 42, 78), s4: hue(140, 44, 72), s5: hue(350, 52, 76), s6: hue(105, 54, 80),
  "s-other": NV(45),
};
const css = Object.entries(T).map(([k, v]) => `  --${k}:${v};`).join("\n") +
  "\n  --accent-soft:var(--accent-container);--ok-soft:var(--ok-container);--warn-soft:var(--warn-container);--bad-soft:var(--bad-container);";

const file = join(here, "..", "src", "mistwatch", "web", "index.html");
let html = readFileSync(file, "utf8");
const nl = html.includes("\r\n") ? "\r\n" : "\n";
html = html.replace(/(\/\* TOKENS:BEGIN[^\r\n]*\*\/\r?\n)[\s\S]*?(  \/\* TOKENS:END \*\/)/, (_, a, b) => a + css.replace(/\n/g, nl) + nl + b)
  .replace(/<meta name="theme-color" content="#[0-9a-f]{6}">/, `<meta name="theme-color" content="${T.bg}">`);
writeFileSync(file, html);
writeFileSync(join(here, "palette.json"), JSON.stringify({ seed: SEED, tokens: T }, null, 2) + "\n");
console.log(Object.entries(T).map(([k, v]) => `${k.padEnd(12)} ${v}`).join("\n"));
