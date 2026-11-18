#!/usr/bin/env python3
"""High-budget §2 read-out (prereg in v5_high_budget_results.md, "§2 ... probe preregistration").

usage: hb_s2_report.py <probe.csv> [out.md]
Main set: Pentobi decisions with own >= 3 (pieces placed before the move). Halves by seed parity
(even = train). Bootstrap: 2,000 resamples of seeds (numpy default_rng(20261118)).
"""
import csv, math, sys
from collections import defaultdict
import numpy as np

rows = list(csv.DictReader(open(sys.argv[1])))
out = sys.argv[2] if len(sys.argv) > 2 else None
for r in rows:
    for k in ["seed", "own", "legal", "rank", "move_contact", "board_contact", "open_corners", "ply"]:
        r[k] = int(r[k])
    for k in ["n_eff", "p_actual", "p_top"]:
        r[k] = float(r[k])
main = [r for r in rows if r["own"] >= 3]
BANDS = [(3, 5), (6, 9), (10, 13), (14, 21)]


def band(o):
    for i, (a, b) in enumerate(BANDS):
        if a <= o <= b:
            return i
    return None


q25 = {}
for i, (a, b) in enumerate(BANDS):
    legal = [r["legal"] for r in main if band(r["own"]) == i]
    q25[i] = np.percentile(legal, 25)
for r in main:
    r["cramped"] = int(r["legal"] <= q25[band(r["own"])])
Ns = [1, 4, 16, 64, 256, 1024]


def w1a(n):
    return math.floor(4 + 1 * math.sqrt(n))


def w1d(n):
    return math.floor(16 + 4 * math.sqrt(n))


def miss(rs, cap):
    return float(np.mean([r["rank"] > cap for r in rs])) if rs else float("nan")


L = []
p = L.append
p(f"Pentobi decisions: {len(rows)} (main set own >= 3: {len(main)}); games' seeds: {len({r['seed'] for r in main})}")
p(f"cramped = legal moves <= band quartile: {dict((f'{a}-{b}', q25[i]) for i, (a, b) in enumerate(BANDS))}")
p("\n## n_eff and rank by own-move band (main set)")
p("| band | n | legal median | n_eff p10 / p50 / p90 | rank p50 / p75 / p90 / p95 | P(rank = 1) | median p_actual |")
p("|---|---:|---:|---:|---:|---:|---:|")
for i, (a, b) in enumerate(BANDS + [(3, 21)]):
    rs = [r for r in main if a <= r["own"] <= b]
    ne = np.array([r["n_eff"] for r in rs]); rk = np.array([r["rank"] for r in rs])
    p(f"| {a}-{b} | {len(rs)} | {np.median([r['legal'] for r in rs]):.0f} | {np.percentile(ne,10):.1f} / {np.percentile(ne,50):.1f} / {np.percentile(ne,90):.1f} | "
      f"{np.percentile(rk,50):.0f} / {np.percentile(rk,75):.0f} / {np.percentile(rk,90):.0f} / {np.percentile(rk,95):.0f} | {np.mean(rk==1):.3f} | {np.median([r['p_actual'] for r in rs]):.4f} |")
p("\n## Miss rate: actual L7 move outside the window at N visits (main set)")
p("| subset | n | " + " | ".join(f"W1A N={n} ({w1a(n)})" for n in Ns) + " | " + " | ".join(f"W1D N={n} ({w1d(n)})" for n in Ns) + " |")
p("|---|---:|" + "---:|" * (2 * len(Ns)))
subsets = [("all", main), ("board contact", [r for r in main if r["board_contact"]]), ("no board contact", [r for r in main if not r["board_contact"]]),
           ("move contact", [r for r in main if r["move_contact"]]), ("no move contact", [r for r in main if not r["move_contact"]]),
           ("cramped", [r for r in main if r["cramped"]]), ("not cramped", [r for r in main if not r["cramped"]])]
for name, rs in subsets:
    p(f"| {name} | {len(rs)} | " + " | ".join(f"{miss(rs, w1a(n)):.3f}" for n in Ns) + " | " + " | ".join(f"{miss(rs, w1d(n)):.3f}" for n in Ns) + " |")
p("\n## Does the miss rate rise when the prior is diffuse? (W1D, main set, n_eff terciles)")
t1, t2 = np.percentile([r["n_eff"] for r in main], [100 / 3, 200 / 3])
p(f"tercile cuts n_eff {t1:.1f}, {t2:.1f}")
p("| n_eff tercile | n | W1D miss N=16 | W1D miss N=64 | W1A miss N=16 | W1A miss N=64 | median legal |")
p("|---|---:|---:|---:|---:|---:|---:|")
for name, lo, hi in [("low (concentrated)", -1, t1), ("middle", t1, t2), ("high (diffuse)", t2, 1e18)]:
    rs = [r for r in main if lo < r["n_eff"] <= hi]
    p(f"| {name} | {len(rs)} | {miss(rs, w1d(16)):.3f} | {miss(rs, w1d(64)):.3f} | {miss(rs, w1a(16)):.3f} | {miss(rs, w1a(64)):.3f} | {np.median([r['legal'] for r in rs]):.0f} |")

# Two-width bins (fixed rule).
train = [r for r in main if r["seed"] % 2 == 0]
test = [r for r in main if r["seed"] % 2 == 1]
med = float(np.median([r["n_eff"] for r in train]))
EVAL_N = [16, 64, 256]


def adaptive(r, n, fd):
    f = fd if r["n_eff"] > med else 2 - fd
    return math.floor(f * (16 + 4 * math.sqrt(n)))


def miss_rate(rs, fd):
    if fd is None:
        return float(np.mean([[r["rank"] > w1d(n) for n in EVAL_N] for r in rs]))
    return float(np.mean([[r["rank"] > adaptive(r, n, fd) for n in EVAL_N] for r in rs]))


p(f"\n## Two-width bins (rule fixed in the prereg); train-half median n_eff = {med:.2f}")
p("| f_d (diffuse) / f_c | train miss, mean over N=16,64,256 |")
p("|---|---:|")
p(f"| W1D (1 / 1) | {miss_rate(train, None):.4f} |")
best = None
for fd in [1.25, 1.5, 1.75]:
    m = miss_rate(train, fd)
    p(f"| {fd} / {2 - fd} | {m:.4f} |")
    if best is None or m < best[1]:
        best = (fd, m)
fd = best[0]
p(f"\nChosen f_d = {fd} (diffuse window floor({fd}·(16 + 4√N)), concentrated floor({2 - fd}·(16 + 4√N))).")
by_seed = defaultdict(list)
for r in test:
    by_seed[r["seed"]].append(r)
seeds = sorted(by_seed)
diff = np.array([np.sum([[(r["rank"] > adaptive(r, n, fd)) - (r["rank"] > w1d(n)) for n in EVAL_N] for r in by_seed[s]]) / len(EVAL_N) for s in seeds])
cnt = np.array([len(by_seed[s]) for s in seeds])
rng = np.random.default_rng(20261118)
idx = rng.integers(0, len(seeds), size=(2000, len(seeds)))
boots = diff[idx].sum(axis=1) / cnt[idx].sum(axis=1)
point = diff.sum() / cnt.sum()
lo, hi = np.percentile(boots, [2.5, 97.5])
p(f"Held-out (test half, {len(test)} decisions, {len(seeds)} seeds): miss W1D {miss_rate(test, None):.4f}, adaptive {miss_rate(test, fd):.4f}; "
  f"difference {point:+.4f} [{lo:+.4f}, {hi:+.4f}] -> {'SUPPORTIVE' if hi < 0 else 'not supportive'}")
p("| N | W1D window | adaptive mean window (test) | W1D miss (test) | adaptive miss (test) | by subset: adaptive − W1D (board contact / cramped) |")
p("|---:|---:|---:|---:|---:|---|")
for n in Ns:
    mw = np.mean([adaptive(r, n, fd) for r in test])
    bc = [r for r in test if r["board_contact"]]
    cr = [r for r in test if r["cramped"]]
    d_bc = np.mean([(r["rank"] > adaptive(r, n, fd)) - (r["rank"] > w1d(n)) for r in bc])
    d_cr = np.mean([(r["rank"] > adaptive(r, n, fd)) - (r["rank"] > w1d(n)) for r in cr])
    p(f"| {n} | {w1d(n)} | {mw:.1f} | {miss(test, w1d(n)):.4f} | {np.mean([r['rank'] > adaptive(r, n, fd) for r in test]):.4f} | {d_bc:+.4f} / {d_cr:+.4f} |")
text = "\n".join(L)
print(text)
if out:
    open(out, "w").write(text + "\n")
