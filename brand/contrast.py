"""WCAG contrast check of the UI tokens (dark only). Exit code 1 on failure."""
import json, sys
from pathlib import Path

T = json.loads((Path(__file__).parent / "palette.json").read_text(encoding="utf-8"))["tokens"]


def lum(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    c = [x / 12.92 if x <= .03928 else ((x + .055) / 1.055) ** 2.4 for x in c]
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]


def cr(a, b):
    x, y = sorted([lum(a), lum(b)], reverse=True)
    return (x + .05) / (y + .05)


def mix(a, b, p):
    A = [int(a[i:i + 2], 16) for i in (1, 3, 5)]; B = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    return "#%02x%02x%02x" % tuple(round(x * p + y * (1 - p)) for x, y in zip(A, B))


surf, bg, fill = T["surface"], T["bg"], T["fill"]
checks = []
for fg in ("text", "text-2", "text-3", "accent", "ok", "warn", "bad"):
    for n, b in (("surface", surf), ("bg", bg), ("fill", fill)):
        checks.append((f"{fg} on {n}", T[fg], b, 4.5))
for k in ("ok", "warn", "bad", "accent"):
    checks.append((f"{k} on {k}-soft badge", T[k], mix(T[k], surf, .14), 4.5))
checks += [("accent-ink on accent (primary button)", T["accent-ink"], T["accent"], 4.5),
           ("surface on bad (solid danger, toast)", surf, T["bad"], 4.5),
           ("bg on text (tooltip, toast)", bg, T["text"], 4.5),
           ("text-3 on accent-soft", T["text-3"], mix(T["accent"], surf, .14), 4.5),
           ("accent focus ring on surface", T["accent"], surf, 3.0)]
for n, b in (("surface", surf), ("bg", bg), ("fill", fill)):
    checks.append((f"line-strong control border on {n}", T["line-strong"], b, 3.0))
for i in range(1, 7):
    checks.append((f"series s{i} on surface", T[f"s{i}"], surf, 3.0))
bad = 0
for n, f, b, m in checks:
    r = cr(f, b)
    if r < m:
        bad += 1
    if r < m or "-v" in sys.argv:
        print(f"{'FAIL' if r < m else 'ok  '} {n}: {r:.2f} (need {m})")
print("fails:", bad)
sys.exit(1 if bad else 0)
