#!/usr/bin/env python3
"""High-budget §1 read-out: the preregistered gate (v5_high_budget_results.md, "§1 ... preregistration").

usage: hb_s1_report.py <positions.jsonl> <probe.jsonl> [out.md]
Fits on the train half (even seeds), judges on the test half (odd seeds); 2,000 bootstrap resamples
of test positions (numpy default_rng(20261118)). Descriptive extras: halves swapped, R^2 of
M_a/M_ab/M_abc, flips against the search's own top move, stranding by piece.
"""
import json, sys
from collections import defaultdict
import numpy as np

pos_path, probe_path = sys.argv[1], sys.argv[2]
out = sys.argv[3] if len(sys.argv) > 3 else None
half = {}
for l in open(pos_path):
    r = json.loads(l)
    half[r["id"]] = r["half"]
rows = [json.loads(l) for l in open(probe_path)]
by_pos = defaultdict(list)
for r in rows:
    by_pos[r["id"]].append(r)
# Only positions with every candidate written (a run cut short may leave a partial last one).
complete = {i: rs for i, rs in by_pos.items() if len(rs) >= 2 and len(rs) == len({x["cand"] for x in rs})}
PIECES = 21
PIECE_NAMES = ["I1", "I2", "I3", "L3", "I4", "O4", "T4", "L4", "Z4", "I5", "L5", "Y5", "N5", "V5", "T5", "Z5", "U5", "W5", "P5", "F5", "X5"]  # RAW_PIECES order


def cand_vars(r):
    seat = r["seat"]
    margins = [f[seat] - (sum(f) - f[seat]) / 3 for f in r["finals"]]
    size = r["piece_size"]
    b = r["b_regions"]
    cs = np.array(r["c_regions"])  # K x 21
    in_hand = [i for i in range(PIECES) if b[i] >= 0]
    B0 = sum(size[i] for i in in_hand if b[i] == 0)
    B1 = sum(size[i] for i in in_hand if b[i] == 1)
    c_zero = {i: float(np.mean(cs[:, i] == 0)) for i in in_hand}
    c_lost = {i: float(np.mean((cs[:, i] == 0) & (b[i] >= 1))) for i in in_hand}
    C0 = sum(size[i] * c_zero[i] for i in in_hand)
    CL = sum(size[i] * c_lost[i] for i in in_hand)
    R = len(r["hands"])
    strand = {i: sum(1 for h in r["hands"] if h & (1 << i)) / R for i in in_hand}
    return dict(Y=float(np.mean(margins)), A=float(np.log(r["visits"] + 1)), B0=B0, B1=B1, C0=C0, CL=CL,
                pieces=[(i, size[i], b[i], c_zero[i], c_lost[i], strand[i]) for i in in_hand], own=r["own"])


data = {}
for i, rs in complete.items():
    rs = sorted(rs, key=lambda x: x["cand"])
    vs = [cand_vars(r) for r in rs]
    for k in ["Y", "A", "B0", "B1", "C0", "CL"]:
        m = np.mean([v[k] for v in vs])
        for v in vs:
            v[k + "c"] = v[k] - m
    data[i] = vs

AB, ABC, A_ = ["Ac", "B0c", "B1c"], ["Ac", "B0c", "B1c", "C0c", "CLc"], ["Ac"]


def design(ids, cols):
    X, y, g = [], [], []
    for i in ids:
        for v in data[i]:
            X.append([v[c] for c in cols])
            y.append(v["Yc"])
            g.append(i)
    return np.array(X), np.array(y), np.array(g)


def fit(ids, cols):
    X, y, _ = design(ids, cols)
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)  # centred data: no intercept
    return beta


def strand_design(ids, with_c):
    X, y, g = [], [], []
    for i in ids:
        for v in data[i]:
            for (p, s, b, cz, cl, st) in v["pieces"]:
                row = [1.0, s, float(b == 0), float(b == 1), float(b == 2), float(v["own"])]
                if with_c:
                    row += [cz, cl]
                X.append(row)
                y.append(st)
                g.append(i)
    return np.array(X), np.array(y), np.array(g)


def per_pos_sum(values, groups, ids):
    acc = defaultdict(float)
    for val, gi in zip(values, groups):
        acc[gi] += val
    return np.array([acc[i] for i in ids])


rng = np.random.default_rng(20261118)


def boot(x, n=2000):
    x = np.asarray(x)
    if len(x) == 0:
        return (float("nan"),) * 3
    idx = rng.integers(0, len(x), size=(n, len(x)))
    m = x[idx].mean(axis=1)
    return float(x.mean()), float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5))


def evaluate(train, test):
    res = {}
    b_ab, b_abc, b_a = fit(train, AB), fit(train, ABC), fit(train, A_)
    res["beta_ab"], res["beta_abc"] = b_ab, b_abc
    X1, y, g = design(test, AB)
    X2, _, _ = design(test, ABC)
    X0, _, _ = design(test, A_)
    e_ab, e_abc, e_a = (y - X1 @ b_ab) ** 2, (y - X2 @ b_abc) ** 2, (y - X0 @ b_a) ** 2
    res["dmse"] = boot(per_pos_sum(e_ab - e_abc, g, test))
    sst = float((y ** 2).sum())
    res["r2"] = {"a": 1 - e_a.sum() / sst, "ab": 1 - e_ab.sum() / sst, "abc": 1 - e_abc.sum() / sst}
    # Stranding.
    Xs0, ys, gs = strand_design(train, False)
    Xs1, _, _ = strand_design(train, True)
    s0, *_ = np.linalg.lstsq(Xs0, ys, rcond=None)
    s1, *_ = np.linalg.lstsq(Xs1, ys, rcond=None)
    T0, yt, gt = strand_design(test, False)
    T1, _, _ = strand_design(test, True)
    br0, br1 = (yt - T0 @ s0) ** 2, (yt - T1 @ s1) ** 2
    res["dbrier"] = boot(per_pos_sum(br0 - br1, gt, test))
    res["strand_beta"] = s1
    # Decisions.
    flips, gains, flips_top, gains_top = [], [], [], []
    for i in test:
        vs = data[i]
        p_ab = [np.dot([v[c] for c in AB], b_ab) for v in vs]
        p_abc = [np.dot([v[c] for c in ABC], b_abc) for v in vs]
        j_ab, j_abc = int(np.argmax(p_ab)), int(np.argmax(p_abc))
        flips.append(j_ab != j_abc)
        gains.append(vs[j_abc]["Y"] - vs[j_ab]["Y"])
        flips_top.append(j_abc != 0)
        gains_top.append(vs[j_abc]["Y"] - vs[0]["Y"])
    res["flip"] = float(np.mean(flips))
    res["gain"] = boot(gains)
    res["flip_top"] = float(np.mean(flips_top))
    res["gain_top"] = boot(gains_top)
    res["n_test"] = len(test)
    return res


train = sorted(i for i in data if half[i] == "train")
test = sorted(i for i in data if half[i] == "test")
main = evaluate(train, test)
swap = evaluate(test, train)
g1m = main["dmse"][1] > 0
g1s = main["dbrier"][1] > 0
g2 = main["flip"] >= 0.05 and main["gain"][1] > 0
lines = []
p = lines.append
p(f"positions complete: {len(data)} (train {len(train)}, test {len(test)}); candidates {sum(len(v) for v in data.values())}")
p(f"continuations per candidate: {len(rows[0]['finals'])}; reply samples: {len(rows[0]['c_regions'])}")
for name, res in [("MAIN (fit train, judge test)", main), ("SWAPPED (descriptive)", swap)]:
    p(f"\n## {name}")
    p(f"- M_ab coefficients (A, B0, B1): {np.round(res['beta_ab'], 4).tolist()}")
    p(f"- M_abc coefficients (A, B0, B1, C0, CL): {np.round(res['beta_abc'], 4).tolist()}")
    p(f"- held-out R^2 of centred margin: M_a {res['r2']['a']:.4f}, M_ab {res['r2']['ab']:.4f}, M_abc {res['r2']['abc']:.4f}")
    d = res["dmse"]
    p(f"- G1-margin: mean per-position delta squared error (M_ab - M_abc) {d[0]:+.4f} [{d[1]:+.4f}, {d[2]:+.4f}]")
    d = res["dbrier"]
    p(f"- G1-strand: mean per-position delta Brier (M_b - M_bc) {d[0]:+.5f} [{d[1]:+.5f}, {d[2]:+.5f}]; M_bc coefs {np.round(res['strand_beta'], 4).tolist()}")
    d = res["gain"]
    p(f"- G2: flip rate {res['flip']:.3f}; mean gain per test position {d[0]:+.3f} [{d[1]:+.3f}, {d[2]:+.3f}] points")
    d = res["gain_top"]
    p(f"- vs the search's top move: M_abc picks another move in {res['flip_top']:.3f}; gain {d[0]:+.3f} [{d[1]:+.3f}, {d[2]:+.3f}]")
p(f"\nGATE: G1-margin {'PASS' if g1m else 'FAIL'}; G1-strand {'PASS' if g1s else 'FAIL'}; G2 {'PASS' if g2 else 'FAIL'} -> {'PASSES' if (g1m and g1s and g2) else 'DOES NOT PASS'}")
# Stranding by piece (descriptive): mean continuation-stranding when in hand after the candidate.
acc = defaultdict(list)
for vs in data.values():
    for v in vs:
        for (pi, s, b, cz, cl, st) in v["pieces"]:
            acc[pi].append((st, cz, b == 0))
p("\n## Stranding by piece (all positions; descriptive)")
p("| piece | rows | stranded at end (cont.) | c: no fit after replies | b: no fit now |")
p("|---|---:|---:|---:|---:|")
for pi in range(PIECES):
    if acc[pi]:
        a = np.array(acc[pi], dtype=float)
        p(f"| {PIECE_NAMES[pi]} | {len(a)} | {a[:,0].mean():.3f} | {a[:,1].mean():.3f} | {a[:,2].mean():.3f} |")
text = "\n".join(lines)
print(text)
if out:
    open(out, "w").write(text + "\n")
