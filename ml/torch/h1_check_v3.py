"""Checks record-format-v3 runs (hybrid H1) and prints their volume. Reads one shard at a time.

    ml/.venv-hybrid/bin/python ml/torch/h1_check_v3.py <run-dir> [<run-dir> ...] [--json out.json]

Per run: every record parses; the chosen move is among the listed moves and equals the game's move at
that ply (`games.jsonl` "moves"); final scores equal the game's; search records' visits sum to the
root's visits and each listed move appears once; teacher records are one-hot on the chosen move;
own-move counts match the hand. Records of games without a `games.jsonl` line (an interrupted run)
are counted and skipped, as the readers skip them. Prints records, games, mean legal moves, mean
nonzero-visit moves and the sources. Exit code 1 if any check fails.
"""

from __future__ import annotations

import glob
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from records_v3 import SOURCE_SEARCH, SOURCE_TEACHER, read_shard  # noqa: E402

POPCOUNT = np.array([bin(i).count("1") for i in range(1 << 16)], dtype=np.int64)


def check(directory: str) -> dict:
    games: dict[int, dict] = {}
    with open(os.path.join(directory, "games.jsonl")) as handle:
        for line in handle:
            g = json.loads(line)
            games[g["game"]] = g
    gmax = max(games) + 1
    has = np.zeros(gmax, bool)
    scores = np.zeros((gmax, 4), np.float32)
    for g, v in games.items():
        has[g] = True
        scores[g] = v["scores"]
    problems: list[str] = []
    stats = {"records": 0, "dropped": 0, "sources": {}, "searchLegal": 0.0, "searchVisited": 0.0, "searchIterations": 0.0,
             "searchN": 0, "teacherLegal": 0.0, "teacherN": 0, "maxLegal": 0}
    seen_games: set[int] = set()
    for shard in sorted(glob.glob(os.path.join(directory, "v3-shard-*.bin"))):
        d = read_shard(shard)
        h, start, moves, visits = d["header"], d["start"], d["moves"], d["visits"]
        gid = h["game"].astype(np.int64)
        keep = (gid < gmax) & has[np.minimum(gid, gmax - 1)]
        stats["dropped"] += int((~keep).sum())
        n = np.diff(start)
        seg = np.repeat(np.arange(len(h)), n)
        is_chosen = moves == np.repeat(h["chosen"], n)
        hit = np.bincount(seg[is_chosen], minlength=len(h)) == 1
        if not hit[keep].all():
            problems.append(f"{shard}: {(~hit[keep]).sum()} records whose chosen move is not listed once")
        key = seg.astype(np.int64) * 65536 + moves
        if len(np.unique(key)) != len(key):
            problems.append(f"{shard}: duplicate moves within a record")
        vsum = np.bincount(seg, weights=visits.astype(np.float64), minlength=len(h))
        search = (h["source"] == SOURCE_SEARCH) & keep
        teacher = (h["source"] == SOURCE_TEACHER) & keep
        if (search & (vsum != h["root_visits"])).any():
            problems.append(f"{shard}: search records whose visits do not sum to the root's")
        if teacher.any():
            ones = np.bincount(seg[is_chosen], weights=visits[is_chosen].astype(np.float64), minlength=len(h))
            if not ((vsum[teacher] == 1) & (ones[teacher] == 1)).all():
                problems.append(f"{shard}: teacher records not one-hot on the chosen move")
        hand = h["hand"][np.arange(len(h)), h["seat"]].astype(np.int64)
        own = 21 - POPCOUNT[hand & 0xFFFF] - POPCOUNT[hand >> 16]
        if not (own[keep] == h["own_moves"][keep]).all():
            problems.append(f"{shard}: own-move counts differ from the hand")
        kept = np.nonzero(keep)[0]
        if not np.array_equal(h["final_scores"][kept], scores[gid[kept]]):
            problems.append(f"{shard}: final scores differ from the games'")
        bad = sum(1 for i in kept if games[int(gid[i])]["moves"][int(h["ply"][i])] != int(h["chosen"][i]))
        if bad:
            problems.append(f"{shard}: {bad} records whose chosen move differs from the game's move")
        seen_games.update(np.unique(gid[kept]).tolist())
        nz = np.bincount(seg, weights=(visits > 0).astype(np.float64), minlength=len(h))
        stats["records"] += len(kept)
        for s in np.unique(h["source"][kept]):
            stats["sources"][int(s)] = stats["sources"].get(int(s), 0) + int((h["source"][kept] == s).sum())
        stats["searchN"] += int(search.sum())
        stats["searchLegal"] += float(n[search].sum())
        stats["searchVisited"] += float(nz[search].sum())
        stats["searchIterations"] += float(h["iterations"][search].sum())
        stats["teacherN"] += int(teacher.sum())
        stats["teacherLegal"] += float(n[teacher].sum())
        stats["maxLegal"] = max(stats["maxLegal"], int(n[keep].max()) if keep.any() else 0)
    missing = set(games) - seen_games
    if missing:
        problems.append(f"{len(missing)} games in games.jsonl without records")
    out = {"run": directory, "games": len(games), "records": stats["records"], "droppedRecords": stats["dropped"],
           "sources": stats["sources"], "maxLegal": stats["maxLegal"], "problems": problems}
    if stats["searchN"]:
        out |= {"searchRecords": stats["searchN"], "searchMeanLegal": stats["searchLegal"] / stats["searchN"],
                "searchMeanVisited": stats["searchVisited"] / stats["searchN"],
                "searchMeanIterations": stats["searchIterations"] / stats["searchN"]}
    if stats["teacherN"]:
        out |= {"teacherRecords": stats["teacherN"], "teacherMeanLegal": stats["teacherLegal"] / stats["teacherN"]}
    print(f"{directory}: {out['games']} games, {out['records']} records ({out['records'] / max(1, out['games']):.1f}/game), "
          f"sources {out['sources']}, {out['droppedRecords']} records of unlisted games skipped")
    if stats["searchN"]:
        print(f"  search records: mean legal {out['searchMeanLegal']:.1f} (max {out['maxLegal']}), "
              f"mean visited moves {out['searchMeanVisited']:.1f}, mean iterations {out['searchMeanIterations']:.0f}")
    if stats["teacherN"]:
        print(f"  teacher records: mean legal {out['teacherMeanLegal']:.1f} (max {out['maxLegal']})")
    print("  OK" if not problems else "  PROBLEMS: " + "; ".join(problems), flush=True)
    return out


if __name__ == "__main__":
    args = sys.argv[1:]
    out_json = None
    if "--json" in args:
        i = args.index("--json")
        out_json = args[i + 1]
        args = args[:i] + args[i + 2 :]
    results = [check(d) for d in args]
    if out_json:
        json.dump(results, open(out_json, "w"), indent=1)
    sys.exit(1 if any(r["problems"] for r in results) else 0)
