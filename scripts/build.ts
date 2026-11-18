import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildWeb } from "./build-web.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
rmSync(dist, { recursive: true, force: true });
const FALLBACK_RATE = 0.86;
const fetchRate = async (): Promise<number> => {
  const forced = Number(process.env.MISTWATCH_USD_TO_EUR);
  if (Number.isFinite(forced) && forced > 0) return forced;
  try {
    const res = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR", {
      signal: AbortSignal.timeout(5000),
    });
    const body: unknown = await res.json();
    const rate = (body as { rates?: { EUR?: unknown } }).rates?.EUR;
    if (typeof rate === "number" && rate > 0.3 && rate < 2) return Math.round(rate * 1e4) / 1e4;
  } catch {}
  console.warn(`could not fetch the USD/EUR rate, using ${FALLBACK_RATE}`);
  return FALLBACK_RATE;
};
const usdToEur = await fetchRate();
console.log(`default usd_to_eur -> ${usdToEur}`);
const web = await buildWeb();
console.log(`web bundle -> ${web.outDir}`);
console.log(`index.html ${web.htmlBytes} bytes (js ${web.jsBytes}, css ${web.cssBytes}) + ${web.assets.length} assets`);
const outfile = join(dist, "cli.js");
await build({
  entryPoints: [join(here, "..", "src", "cli.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  external: ["@napi-rs/keyring"],
  define: { __USD_TO_EUR__: String(usdToEur) },
  outfile,
  logLevel: "silent",
});
console.log(`cli bundle -> ${outfile}`);
