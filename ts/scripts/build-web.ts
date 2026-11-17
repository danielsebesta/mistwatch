import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export type WebBuildResult = { outDir: string; htmlBytes: number; jsBytes: number; cssBytes: number; assets: string[] };

const ASSETS = [
  "favicon.svg",
  "favicon.ico",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "logo.svg",
  "logo-dark.svg",
  "mark.svg",
  "site.webmanifest",
];

export async function buildWeb(): Promise<WebBuildResult> {
  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = join(here, "..", "web");
  const outDir = join(here, "..", "dist", "web");
  const pubDir = join(webDir, "public");
  const srcAssets = join(here, "..", "..", "src", "mistwatch", "web");
  mkdirSync(pubDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  for (const f of ASSETS) {
    copyFileSync(join(srcAssets, f), join(pubDir, f));
    copyFileSync(join(srcAssets, f), join(outDir, f));
  }
  const res = await build({
    entryPoints: [join(webDir, "src", "main.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    write: false,
    logLevel: "silent",
  });
  const js = res.outputFiles[0]?.text ?? "";
  if (!js) throw new Error("esbuild produced no output");
  const css = readFileSync(join(webDir, "styles.css"), "utf8");
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  // function replacers so $ sequences in the bundle stay literal; </script> would break the inline block
  const out = html
    .replace("/*INLINE-STYLE*/", () => css.replace(/<\/style/gi, "<\\/style"))
    .replace("/*INLINE-SCRIPT*/", () => `\n"use strict";\n${js.replace(/<\/script/gi, "<\\/script")}`);
  writeFileSync(join(outDir, "index.html"), out);
  return { outDir, htmlBytes: out.length, jsBytes: js.length, cssBytes: css.length, assets: [...ASSETS] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await buildWeb();
  console.log(`web bundle -> ${r.outDir}`);
  console.log(`index.html ${r.htmlBytes} bytes (js ${r.jsBytes}, css ${r.cssBytes}) + ${r.assets.length} assets`);
}
