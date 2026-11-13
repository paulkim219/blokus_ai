#!/usr/bin/env python3
"""D1: check that replayed bridge games equal the original run, by (seed, seat), score for score.

  python3 engine-rs/scripts/d1_compare.py tmp/x1/x1-l6a.jsonl tmp/d1/x1-l6a.jsonl [tmp/d1/x1-l6a.moves.jsonl]
Exit 0 only if every pair in the replay exists in the original with identical scores and winner
(and, if given, the moves file carries the same scores); prints a count of games not yet replayed.
"""
import json, sys

def load(path):
    out = {}
    for line in open(path):
        if line.strip():
            v = json.loads(line)
            out[(v["seed"], v["seat"])] = v
    return out

orig, rep = load(sys.argv[1]), load(sys.argv[2])
moves = load(sys.argv[3]) if len(sys.argv) > 3 else None
bad = 0
for key, v in sorted(rep.items()):
    o = orig.get(key)
    if o is None:
        print("not in original:", key); bad += 1; continue
    if o["scores"] != v["scores"] or o["winner"] != v["winner"] or o["challengerMoves"] != v["challengerMoves"]:
        print("MISMATCH", key, "original", o["scores"], o["winner"], o["challengerMoves"], "replay", v["scores"], v["winner"], v["challengerMoves"]); bad += 1
    if moves is not None:
        m = moves.get(key)
        if m is None or m["scores"] != v["scores"]:
            print("moves file disagrees or missing", key); bad += 1
missing = len(set(orig) - set(rep))
print(f"{len(rep)} replayed games compared, {bad} mismatches, {missing} original games not in the replay")
sys.exit(1 if bad else 0)
