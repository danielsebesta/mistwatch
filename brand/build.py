"""Builds the Mistwatch logo and favicons from the Tiny5 pixel font (SIL OFL 1.1, see OFL.txt).

Glyphs of Tiny5 are sets of 128-unit squares, so letters are read as pixel grids and drawn as plain
rectangles: the output SVGs need no font. Run:  uv run --no-project --with fonttools --with pillow python brand/build.py
Then optimise:  npx svgo -f web/public --config brand/svgo.config.mjs
"""
from __future__ import annotations

import json
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw

HERE = Path(__file__).parent
OUT = HERE.parent / "web" / "public"
FONT = TTFont(HERE / "Tiny5-Regular.ttf")
CMAP, GLYF = FONT.getBestCmap(), FONT["glyf"]

# sunset amber -> coral; a pixel-stepped gradient (not Mistral's yellow-orange-red)
STEPS = ["#ffc233", "#ffa21f", "#ff7f2a", "#f95a3b", "#e8384f"]
PAL = json.loads((HERE / "palette.json").read_text(encoding="utf-8"))["tokens"]  # from brand/palette.mjs
TILE, INK_DARK, INK_LIGHT = PAL["bg"], PAL["bg"], PAL["text"]


def letter(ch: str) -> list[tuple[int, int]]:
    """Pixels (col, row from top) of a Tiny5 capital, 5 rows high."""
    g = GLYF[CMAP[ord(ch)]]
    cells = [((c.x - 64) // 128, (c.y - 64) // 128) for c in g.components]
    return [(x, 4 - y) for x, y in cells]


def text(s: str) -> tuple[list[tuple[int, int]], int]:
    px, x = [], 0
    for ch in s:
        px += [(x + cx, cy) for cx, cy in letter(ch)]
        x += FONT["hmtx"][CMAP[ord(ch)]][0] // 128  # advance in cells (glyph width + 1 gap)
    return px, x - 1


def gradient(px: list[tuple[int, int]], width: int) -> dict[tuple[int, int], str]:
    """Diagonal gradient, quantised to 5 steps with a 2x2 ordered dither so the steps read as pixels."""
    bayer = [[-.5, .25], [.0, -.25]]
    out = {}
    for x, y in px:
        t = (y + .5) / 5 * .62 + x / max(width - 1, 1) * .38
        t += bayer[y % 2][x % 2] * .16
        out[(x, y)] = STEPS[min(len(STEPS) - 1, max(0, int(t * len(STEPS))))]
    return out


def rects(cells: dict[tuple[int, int], str], dx=0, dy=0) -> str:
    by: dict[str, list[str]] = {}
    for (x, y), c in sorted(cells.items(), key=lambda i: (i[1], i[0][1], i[0][0])):
        by.setdefault(c, []).append(f"M{x + dx} {y + dy}h1v1h-1z")
    return "".join(f'<path fill="{c}" d="{"".join(d)}"/>' for c, d in by.items())


def tile_path(n: int, notch: bool) -> str:
    if not notch:
        return f"M0 0h{n}v{n}H0z"
    return f"M1 0h{n - 2}v1h1v{n - 2}h-1v1H1v-1H0V1h1z"


MARK_PX, MARK_W = text("MW")
MARK = gradient(MARK_PX, MARK_W)
GRID, MX, MY = 15, 2, 5  # 15-cell tile, 11x5 mark centred at (2,5)


def favicon_svg() -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {GRID} {GRID}" shape-rendering="crispEdges">'
            f'<path fill="{TILE}" d="{tile_path(GRID, True)}"/>{rects(MARK, MX, MY)}</svg>')


def mark_svg() -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {MARK_W} 5" shape-rendering="crispEdges">{rects(MARK)}</svg>'


def logo_svg(ink: str) -> str:
    wm, ww = text("MISTWATCH")
    gap = 3
    w = GRID + gap + ww
    word = "".join(f"M{x + GRID + gap} {y + MY}h1v1h-1z" for x, y in wm)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {GRID}" shape-rendering="crispEdges">'
            f'<path fill="{TILE}" d="{tile_path(GRID, True)}"/>{rects(MARK, MX, MY)}<path fill="{ink}" d="{word}"/></svg>')


def hex_rgb(h: str):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def raster(size: int, notch: bool) -> Image.Image:
    """notch=True: the favicon tile (15 cells of c px, centred); False: full-bleed square with a centred mark."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    bg = hex_rgb(TILE)
    if notch:
        c = size // GRID
        ox = oy = (size - GRID * c) // 2
        r = lambda x0, y0, x1, y1: d.rectangle([ox + x0 * c, oy + y0 * c, ox + x1 * c - 1, oy + y1 * c - 1], fill=bg)  # noqa: E731
        r(0, 1, GRID, GRID - 1)
        r(1, 0, GRID - 1, GRID)
        mx, my = ox + MX * c, oy + MY * c
    else:
        d.rectangle([0, 0, size - 1, size - 1], fill=bg)
        c = max(1, round(size * 0.66 / MARK_W))
        mx, my = (size - MARK_W * c) // 2, (size - 5 * c) // 2
    for (x, y), col in MARK.items():
        d.rectangle([mx + x * c, my + y * c, mx + (x + 1) * c - 1, my + (y + 1) * c - 1], fill=hex_rgb(col))
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "favicon.svg").write_text(favicon_svg(), encoding="utf-8")
    (OUT / "mark.svg").write_text(mark_svg(), encoding="utf-8")
    (OUT / "logo.svg").write_text(logo_svg(INK_DARK), encoding="utf-8")
    (OUT / "logo-dark.svg").write_text(logo_svg(INK_LIGHT), encoding="utf-8")
    raster(48, True).save(OUT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)],
                          append_images=[raster(16, True), raster(32, True)])
    raster(180, False).save(OUT / "apple-touch-icon.png", optimize=True)
    raster(192, False).save(OUT / "icon-192.png", optimize=True)
    raster(512, False).save(OUT / "icon-512.png", optimize=True)
    (OUT / "site.webmanifest").write_text(
        '{"name":"Mistwatch","short_name":"Mistwatch","start_url":"/","display":"standalone","background_color":"' + TILE + '",'
        '"theme_color":"' + TILE + '","icons":[{"src":"/icon-192.png","sizes":"192x192","type":"image/png"},'
        '{"src":"/icon-512.png","sizes":"512x512","type":"image/png"},{"src":"/favicon.svg","sizes":"any","type":"image/svg+xml"}]}',
        encoding="utf-8")


if __name__ == "__main__":
    main()
