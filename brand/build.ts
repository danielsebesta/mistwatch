// Builds the Mistwatch logo and favicons. Run: npx tsx brand/build.ts   (output goes to web/public, or to $OUT)
// Then optimise: npx svgo@3 --config brand/svgo.config.mjs web/public/*.svg
//
// Letters are pixel grids: each capital is a list of (column, row from top) cells, 5 rows high. The output
// SVGs are plain rectangles.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? join(HERE, "..", "web", "public");

type Cell = [number, number];
const GLYPHS: Record<string, { cells: Cell[]; adv: number }> = {
  M: { cells: [[0, 4], [4, 4], [0, 3], [4, 3], [0, 2], [2, 2], [4, 2], [0, 1], [1, 1], [3, 1], [4, 1], [0, 0], [4, 0]], adv: 6 },
  W: { cells: [[1, 4], [3, 4], [1, 3], [3, 3], [0, 2], [2, 2], [4, 2], [0, 1], [2, 1], [4, 1], [0, 0], [2, 0], [4, 0]], adv: 6 },
  I: { cells: [[0, 4], [0, 3], [0, 2], [0, 1], [0, 0]], adv: 2 },
  S: { cells: [[0, 4], [1, 4], [2, 4], [3, 3], [1, 2], [2, 2], [0, 1], [1, 0], [2, 0], [3, 0]], adv: 5 },
  T: { cells: [[1, 4], [1, 3], [1, 2], [1, 1], [0, 0], [1, 0], [2, 0]], adv: 4 },
  A: { cells: [[0, 4], [3, 4], [0, 3], [3, 3], [0, 2], [1, 2], [2, 2], [3, 2], [0, 1], [3, 1], [1, 0], [2, 0]], adv: 5 },
  C: { cells: [[1, 4], [2, 4], [3, 4], [0, 3], [0, 2], [0, 1], [1, 0], [2, 0], [3, 0]], adv: 5 },
  H: { cells: [[0, 4], [3, 4], [0, 3], [3, 3], [0, 2], [1, 2], [2, 2], [3, 2], [0, 1], [3, 1], [0, 0], [3, 0]], adv: 5 },
};

// sunset amber -> coral; a pixel-stepped gradient
const STEPS = ["#ffc233", "#ffa21f", "#ff7f2a", "#f95a3b", "#e8384f"];
const tokens = JSON.parse(readFileSync(join(HERE, "palette.json"), "utf8")).tokens as Record<string, string>;
const BG = tokens.bg as string;
const INK_DARK = BG;
const INK_LIGHT = tokens.text as string;

const text = (s: string): { px: Cell[]; width: number } => {
  const px: Cell[] = [];
  let x = 0;
  for (const ch of s) {
    const g = GLYPHS[ch];
    if (!g) throw new Error(`no glyph for ${ch}`);
    for (const [cx, cy] of g.cells) px.push([x + cx, cy]);
    x += g.adv; // advance in cells (glyph width + 1 gap)
  }
  return { px, width: x - 1 };
};

// Diagonal gradient, quantised to 5 steps with a 2x2 ordered dither so the steps read as pixels.
const BAYER = [
  [-0.5, 0.25],
  [0.0, -0.25],
];
const gradient = (px: Cell[], width: number): { x: number; y: number; c: string }[] =>
  px.map(([x, y]) => {
    let t = ((y + 0.5) / 5) * 0.62 + (x / Math.max(width - 1, 1)) * 0.38;
    t += (BAYER[y % 2]?.[x % 2] ?? 0) * 0.16;
    const i = Math.min(STEPS.length - 1, Math.max(0, Math.trunc(t * STEPS.length)));
    return { x, y, c: STEPS[i] as string };
  });

const MARK = text("MW");
const CELLS = gradient(MARK.px, MARK.width);

const rects = (dx = 0, dy = 0): string => {
  const by = new Map<string, string[]>();
  const sorted = [...CELLS].sort((a, b) => (a.c < b.c ? -1 : a.c > b.c ? 1 : a.y - b.y || a.x - b.x));
  for (const { x, y, c } of sorted) {
    const d = by.get(c) ?? [];
    d.push(`M${x + dx} ${y + dy}h1v1h-1z`);
    by.set(c, d);
  }
  return [...by].map(([c, d]) => `<path fill="${c}" d="${d.join("")}"/>`).join("");
};

const mark = (): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK.width} 5" shape-rendering="crispEdges">${rects()}</svg>`;
// The mark and the wordmark side by side, no tile.
const logo = (ink: string): string => {
  const wm = text("MISTWATCH");
  const gap = 3;
  const w = MARK.width + gap + wm.width;
  const word = wm.px.map(([x, y]) => `M${x + MARK.width + gap} ${y}h1v1h-1z`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 5" shape-rendering="crispEdges">${rects()}<path fill="${ink}" d="${word}"/></svg>`;
};

type RGB = [number, number, number];
const hexRgb = (h: string): RGB => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as RGB;

// RGBA raster: the mark on a transparent square, as large as whole pixels allow.
const raster = (size: number): Uint8Array => {
  const px = new Uint8Array(size * size * 4); // transparent
  const c = Math.max(1, Math.floor(size / MARK.width));
  const mx = Math.floor((size - MARK.width * c) / 2);
  const my = Math.floor((size - 5 * c) / 2);
  for (const { x, y, c: col } of CELLS) {
    const [r, g, b] = hexRgb(col);
    for (let yy = my + y * c; yy < my + (y + 1) * c; yy++)
      for (let xx = mx + x * c; xx < mx + (x + 1) * c; xx++) px.set([r, g, b, 255], (yy * size + xx) * 4);
  }
  return px;
};

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array): Buffer => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const png = (size: number, rgba: Uint8Array): Buffer => {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
// ICO container holding PNG images
const ico = (sizes: number[]): Buffer => {
  const images = sizes.map((s) => png(s, raster(s)));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map((img, i) => {
    const e = Buffer.alloc(16);
    const s = sizes[i] as number;
    e[0] = s;
    e[1] = s;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(img.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.length;
    return e;
  });
  return Buffer.concat([head, ...entries, ...images]);
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "favicon.svg"), mark());
writeFileSync(join(OUT, "mark.svg"), mark());
writeFileSync(join(OUT, "logo.svg"), logo(INK_DARK));
writeFileSync(join(OUT, "logo-dark.svg"), logo(INK_LIGHT));
writeFileSync(join(OUT, "favicon.ico"), ico([16, 32, 48]));
for (const [name, size] of [
  ["apple-touch-icon", 180],
  ["icon-192", 192],
  ["icon-512", 512],
] as const)
  writeFileSync(join(OUT, `${name}.png`), png(size, raster(size)));
writeFileSync(
  join(OUT, "site.webmanifest"),
  JSON.stringify({
    name: "Mistwatch",
    short_name: "Mistwatch",
    start_url: "/",
    display: "standalone",
    background_color: BG,
    theme_color: BG,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  }),
);
