"""Checks a record-format-v3 run (hybrid H1) and prints its volume.

    ml/.venv-hybrid/bin/python ml/torch/h1_check_v3.py <run-dir> [<run-dir> ...]

Per run: every record parses; the chosen move is among the listed moves and equals the game's move at
that ply (`games.jsonl` "moves"); final scores equal the game's; search records' visits sum to the
root's visits and each listed move appears once; teacher records are one-hot on the chosen move;
own-move counts match the hand. Prints records, games, mean legal moves, mean nonzero-visit moves,
and the sources.
"""

from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from records_v3 import SOURCE_SEARCH, SOURCE_TEACHER, load_run_v3  # noqa: E402


def check(directory: str) -> None:
    run, games = load_run_v3(directory)
    h, start, moves, visits = run["header"], run["start"], run["moves"], run["visits"]
    n = np.diff(start)
    problems = []
    seg = np.repeat(np.arange(len(h)), n)
    # chosen among the listed moves
    hit = np.zeros(len(h), bool)
    is_chosen = moves == np.repeat(h["chosen"], n)
    np.logical_or.at(hit, seg, is_chosen)
    if not hit.all():
        problems.append(f"{(~hit).sum()} records whose chosen move is not listed")
    # unique moves per record
    key = seg.astype(np.int64) * 65536 + moves
    if len(np.unique(key)) != len(key):
        problems.append("duplicate moves within a record")
    search = h["source"] == SOURCE_SEARCH
    vsum = np.add.reduceat(visits.astype(np.int64), start[:-1]) if len(h) else np.zeros(0)
    vsum = np.where(n > 0, vsum, 0)
    bad = search & (vsum != h["root_visits"])
    if bad.any():
        problems.append(f"{bad.sum()} search records whose visits do not sum to the root's")
    teacher = h["source"] == SOURCE_TEACHER
    if teacher.any():
        ones = np.add.reduceat((visits * is_chosen).astype(np.int64), start[:-1])
        if not ((vsum[teacher] == 1) & (ones[teacher] == 1)).all():
            problems.append("teacher records not one-hot on the chosen move")
    own = 21 - np.array([bin(int(x)).count("1") for x in h["hand"][np.arange(len(h)), h["seat"]]])
    if not (own == h["own_moves"]).all():
        problems.append("own-move counts differ from the hand")
    for i in range(len(h)):
        g = games[int(h["game"][i])]
        if "moves" in g and g["moves"][int(h["ply"][i])] != int(h["chosen"][i]):
            problems.append(f"record {i}: chosen differs from the game's move")
            break
        if not np.array_equal(h["final_scores"][i], np.array(g["scores"], dtype=np.float32)):
            problems.append(f"record {i}: final scores differ from the game's")
            break
    nz = np.add.reduceat((visits > 0).astype(np.int64), start[:-1])
    sources = {int(s): int((h["source"] == s).sum()) for s in np.unique(h["source"])}
    print(f"{directory}: {len(games)} games, {len(h)} records ({len(h) / max(1, len(games)):.1f}/game), sources {sources}")
    if search.any():
        print(f"  search records: mean legal {n[search].mean():.1f} (max {n[search].max()}), mean visited moves {nz[search].mean():.1f}, "
              f"mean iterations {h['iterations'][search].mean():.0f}, root values finite {np.isfinite(h['root_values'][search]).all()}")
    if teacher.any():
        print(f"  teacher records: mean legal {n[teacher].mean():.1f} (max {n[teacher].max()}), levels {sorted(set(h['teacher'][teacher].tolist()))}")
    print("  OK" if not problems else "  PROBLEMS: " + "; ".join(problems))


if __name__ == "__main__":
    for d in sys.argv[1:]:
        check(d)
