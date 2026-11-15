"""Round 5, Stage 2: measured shapes of the search effort over a seat's own moves.

    python3 engine-rs/scripts/v52_shapes.py > tmp/v52/shape/shapes.md

- Blokee (`v5.1-ultra`): iterations per own move from p4_cost rows (recorded positions, config 0 = base) and
  in-match wall ms per own move (timing logs of the round-4 per-seat 800-seed v5.1 blocks);
- Pentobi level 6, per-seat processes: new simulations per own move from the `--pentobi-log` statistics of
  round 4 (tmp/v51d/S1/stats; book moves have no statistics line, so a seat's k searched moves are its last k).
"""
import csv, glob, json, os, re, statistics as st
from collections import defaultdict

TURN = ["blue", "green", "purple", "yellow"]
DISPLAY = ["blue", "yellow", "purple", "green"]

it = defaultdict(list)
names = open("tmp/v51d/S2/cost/screen-round1.names").read().split()
for r in csv.DictReader(open("tmp/v51d/S2/cost/screen-round1.csv")):
    if names[int(r["config"])] == "base":
        it[int(r["own_idx"])].append(int(r["iterations"]))
ms = defaultdict(list)
for f in glob.glob("tmp/v51d/S1/c*/lone-v5.1-ultra.timing.jsonl"):
    for l in open(f):
        t = json.loads(l)
        for k, x in enumerate(t["blokeeMs"]):
            ms[k].append(x)
sims = defaultdict(list)
tim = {}
for l in open("tmp/v51d/S1/stats/stats.timing.jsonl"):
    t = json.loads(l)
    tim[(t["seed"], t["seat"])] = t["msBySeat"]
for f in glob.glob("tmp/v51d/S1/stats/logs/*.log"):
    seed, disp, p = map(int, os.path.basename(f)[:-4].split("-"))
    lone = DISPLAY[disp]
    pent = [c for c in TURN if c != lone]
    colour = pent[p]
    moves = len(tim[(seed, lone)][colour])
    s = [int(m.group(1)) for m in (re.search(r"Vst \d+, Sim (\d+)", x) for x in open(f, errors="ignore")) if m]
    for j, v in enumerate(s):
        sims[moves - len(s) + j].append(v)
print("| Own move | Blokee iterations (p4_cost positions) | n | Blokee in-match ms (per-seat, 800 seeds) | Pentobi L6 new simulations | n |")
print("|---:|---:|---:|---:|---:|---:|")
for k in range(21):
    a = f"{st.mean(it[k]):.0f}" if it.get(k) else "—"
    b = f"{st.mean(ms[k]):.1f}" if ms.get(k) else "—"
    c = f"{st.mean(sims[k]):.0f}" if sims.get(k) else "—"
    print(f"| {k} | {a} | {len(it.get(k, []))} | {b} | {c} | {len(sims.get(k, []))} |")
json.dump({"blokee_iterations": {k: st.mean(v) for k, v in it.items()}, "blokee_ms": {k: st.mean(v) for k, v in ms.items()},
           "pentobi_sims": {k: st.mean(v) for k, v in sims.items()}}, open("tmp/v52/shape/shapes.json", "w"), indent=1)
