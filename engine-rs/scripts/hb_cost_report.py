#!/usr/bin/env python3
"""High-budget quiet-slot cost read-out: candidate / control clean ms from two p4_cost rounds.

usage: hb_cost_report.py <quiet dir> <label> <control-name> <candidate-name>
Reads <label>-r1.csv/.names and <label>-r2.csv/.names. With three configs per round the first is the
unscored warm-up (round 9 procedure) and is skipped; names are matched by file basename (without .json),
taking the scored occurrence. Prints per-round means and ratios, and the mean of the two ratios.
"""
import csv, os, sys
from collections import defaultdict

qd, label, ctl, cand = sys.argv[1:5]
ratios = []
for r in ["r1", "r2"]:
    path = os.path.join(qd, f"{label}-{r}.csv")
    if not os.path.exists(path):
        print(f"{label}-{r}: missing")
        continue
    names = [os.path.basename(l.strip())[:-5] for l in open(os.path.join(qd, f"{label}-{r}.names")) if l.strip()]
    skip = 1 if len(names) == 3 else 0
    idx = {}
    for i, n in enumerate(names):
        if i >= skip:
            idx[n] = i
    ms, it, same = defaultdict(list), defaultdict(list), defaultdict(list)
    for row in csv.DictReader(open(path)):
        c = int(row["config"])
        ms[c].append(float(row["ms"]))
        it[c].append(int(row["iterations"]))
        same[c].append(int(row["same_as_first"]))
    a, b = idx[ctl], idx[cand]
    ma, mb = sum(ms[a]) / len(ms[a]), sum(ms[b]) / len(ms[b])
    ratios.append(mb / ma)
    print(f"{label}-{r}: positions {len(ms[a])}; {ctl} {ma:.1f} ms, {cand} {mb:.1f} ms, ratio {mb / ma:.4f}; "
          f"iterations {sum(it[a]) / len(it[a]):.0f} vs {sum(it[b]) / len(it[b]):.0f}; "
          f"same move as config 0: {sum(same[a])}/{len(same[a])} vs {sum(same[b])}/{len(same[b])}")
if ratios:
    print(f"{label}: mean ratio {cand} / {ctl} = {sum(ratios) / len(ratios):.4f} over {len(ratios)} round(s)")
