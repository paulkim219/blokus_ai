#!/usr/bin/env python3
"""Round 11 Step A read-out and the preregistered shape choice.

usage: v58_probe_report.py <probe dir>    (reads <arm>.csv and <arm>.time for U, U-1pct and the cap arms)
Prints the table; the last line is `chosen: <arm>`.
"""
import csv, os, re, sys

d = sys.argv[1]
ARMS = ["U", "U-1pct", "U16-4", "U16-8", "U32-8", "U64-16"]
CAPS = {"U16-4": (16, 4), "U16-8": (16, 8), "U32-8": (32, 8), "U64-16": (64, 16)}
TARGET, TIE, RSS_MAX = 0.39, 0.05, 6.0


def rss(arm):
    p = os.path.join(d, f"{arm}.time")
    m = re.search(r"(\d+)\s+maximum resident set size", open(p).read()) if os.path.exists(p) else None
    return int(m.group(1)) / 1e9 if m else float("nan")


rows = {a: list(csv.DictReader(open(os.path.join(d, f"{a}.csv")))) for a in ARMS if os.path.exists(os.path.join(d, f"{a}.csv"))}
base = {r["pos"]: r for r in rows["U"]}
st = {}
print("| Arm | Positions | Mean depth | Δ depth vs U | Mean max depth | Same best as U | Iterations | Tree bytes / iteration | Largest tree (GB) | Peak RSS (GB) | ms/search (parallel, not timing) |")
print("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
for a, rs in rows.items():
    n = len(rs)
    dm = sum(float(r["depth_mean"]) for r in rs) / n
    dx = sum(float(r["depth_max"]) for r in rs) / n
    same = sum(r["best"] == base[r["pos"]]["best"] for r in rs)
    it = sum(int(r["iterations"]) for r in rs) / n
    bpi = sum(int(r["tree_bytes"]) for r in rs) / sum(int(r["iterations"]) for r in rs)
    big = max(int(r["tree_bytes"]) for r in rs) / 1e9
    ms = sum(float(r["ms"]) for r in rs) / n
    st[a] = dict(n=n, dm=dm, same=same, rss=rss(a))
    bd = sum(float(r["depth_mean"]) for r in rows["U"]) / len(rows["U"])
    print(f"| {a} | {n} | {dm:.2f} | {dm - bd:+.2f} | {dx:.1f} | {same}/{n} | {it:,.0f} | {bpi:,.0f} | {big:.2f} | {st[a]['rss']:.2f} | {ms:,.0f} |")
noise = st["U-1pct"]["same"]
print(f"\nNoise reference U-1pct: same best {noise}/{st['U-1pct']['n']}.")
cand = []
for a, (i, g) in CAPS.items():
    if a not in st:
        continue
    gain = st[a]["dm"] - st["U"]["dm"]
    binding = st[a]["same"] <= noise - 3
    mem = st[a]["rss"] <= RSS_MAX
    print(f"- {a}: depth gain {gain:+.3f} (|gain − {TARGET}| = {abs(gain - TARGET):.3f}); binding {'yes' if binding else 'NO'} "
          f"(same best {st[a]['same']} vs noise {noise}); peak RSS {st[a]['rss']:.2f} GB {'ok' if mem else 'OVER 6 GB'}")
    if binding and mem:
        cand.append((abs(gain - TARGET), i, g, a))
if not cand:
    print("No arm passes the binding and memory gates: the pilot plays U16-4 (prereg rule 4).")
    print("chosen: U16-4")
    sys.exit()
best = min(c[0] for c in cand)
tied = [c for c in cand if c[0] <= best + TIE]
pick = max(tied, key=lambda c: (c[1], c[2]))
print(f"Closest to +{TARGET}: {', '.join(c[3] for c in tied)} (within {TIE}); tie broken toward the wider arm.")
print(f"chosen: {pick[3]}")
