#!/usr/bin/env python3
"""High-budget §1: development positions for the stranding probe (prereg in v5_high_budget_results.md).

Sources (completed pro games vs three L7 seats; none from round 10's seeds):
  round 9 pro screen, 101,500,000-101,500,299: tmp/v56/pro/screen/rol-{base,W1A-ET,W1D-ET}.moves.jsonl
  round 6 pro baseline (S2):                    tmp/v53/S2/pro-L7.moves.jsonl
One position per game at most: the lone Blokee seat's decision at own turn k (k = pieces it has
placed + 1), k drawn uniformly from 9..16 (if the seat has no k-th placement, the game is skipped).
Stratified: 4 lone seats x {win, loss} (win = lone score above the mean of the other three)
x PER positions, drawn with random.Random(20261117) from the eligible games.
Split: 'train' = even seed, 'test' = odd seed (all games of a seed fall in one half).
usage: hb_positions.py <out.jsonl> [PER=30]
"""
import json, random, sys

T = "/Users/paulkim/Blokee/tmp"
FILES = [f"{T}/v56/pro/screen/rol-base.moves.jsonl", f"{T}/v56/pro/screen/rol-W1A-ET.moves.jsonl",
         f"{T}/v56/pro/screen/rol-W1D-ET.moves.jsonl", f"{T}/v53/S2/pro-L7.moves.jsonl"]
COLORS = ["blue", "green", "purple", "yellow"]
out = sys.argv[1]
per = int(sys.argv[2]) if len(sys.argv) > 2 else 30
rng = random.Random(20261117)
strata = {}
for fi, f in enumerate(FILES):
    for line in open(f):
        g = json.loads(line)
        assert not (102_000_000 <= g["seed"] < 103_000_000), "round-10 seed"
        lone = COLORS.index(g["seat"])
        sc = g["scores"]
        adv = sc[g["seat"]] - sum(sc[c] for c in COLORS if c != g["seat"]) / 3
        k = rng.randint(9, 16)
        # Replay turn order: seat order is blue, yellow, red... use the engine order: seats 0..3 in turn.
        moves = g["moves"]
        placed, ply_at = 0, None
        for ply, mv in enumerate(moves):
            seat = ply % 4
            if seat == lone and mv >= 0:
                placed += 1
                if placed == k:
                    ply_at = ply
                    break
        if ply_at is None:
            continue
        key = (lone, adv > 0)
        strata.setdefault(key, []).append({"file": fi, "seed": g["seed"], "seat": lone, "own_turn": k,
                                           "adv": adv, "moves": moves[:ply_at], "label": g.get("label")})
rows = []
for key in sorted(strata):
    pool = strata[key]
    rng.shuffle(pool)
    if len(pool) < per:
        print("stratum", key, "has only", len(pool), file=sys.stderr)
    rows.extend(pool[:per])
rng.shuffle(rows)
with open(out, "w") as w:
    for i, r in enumerate(rows):
        r["id"] = i
        r["half"] = "train" if r["seed"] % 2 == 0 else "test"
        w.write(json.dumps(r) + "\n")
from collections import Counter
print(len(rows), "positions;", Counter(r["half"] for r in rows), Counter(r["file"] for r in rows),
      Counter(r["own_turn"] for r in rows), file=sys.stderr)
