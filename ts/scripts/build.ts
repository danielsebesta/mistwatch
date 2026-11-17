import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildWeb } from "./build-web.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
rmSync(dist, { recursive: true, force: true });
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
  outfile,
  logLevel: "silent",
});
console.log(`cli bundle -> ${outfile}`);
