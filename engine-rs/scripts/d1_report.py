#!/usr/bin/env python3
"""D1 game anatomy report: Blokee seats against Pentobi seats in the X1 level-6 blocks.

Inputs are the CSVs written by `cargo run --release --example d1_anatomy -- turns ...` (one per
block) and, optionally, the `judge` CSV and the bridge's `.timing.jsonl` side files.

  python3 engine-rs/scripts/d1_report.py tmp/d1 > tmp/d1/tables.md

Every difference is Blokee minus Pentobi. A game contributes (Blokee-seat mean − Pentobi-seat mean)
within that game, so each seed's four seat rotations balance turn order; seeds are the bootstrap
unit (2,000 resamples, percentile 95% interval).
"""
import json, sys, os
import numpy as np
import pandas as pd

D = sys.argv[1] if len(sys.argv) > 1 else "tmp/d1"
BLOCKS = {"l6a": "x1-l6a", "l6b": "x1-l6b"}
SEATS = ["blue", "green", "purple", "yellow"]  # turn order
RNG = np.random.default_rng(20261112)
B = 2000
SIZES = [1, 2, 3, 3] + [4] * 5 + [5] * 12
PIECES = ["I1", "I2", "I3", "L3", "I4", "O4", "T4", "L4", "Z4", "I5", "L5", "Y5", "N5", "V5", "T5", "Z5", "U5", "W5", "P5", "F5", "X5"]


def load():
    turns, seats = [], []
    for b, stem in BLOCKS.items():
        t = pd.read_csv(f"{D}/{stem}.turns.csv")
        s = pd.read_csv(f"{D}/{stem}.seats.csv")
        t["block"], s["block"] = b, b
        # Book flag for Pentobi moves: per-move wall time from the timing side file (< 1 ms).
        timing = {}
        for line in open(f"{D}/{stem}.timing.jsonl"):
            v = json.loads(line)
            for c, ms in v["msBySeat"].items():
                timing[(v["seed"], v["seat"], c)] = ms
        def ms_of(r):
            if r.pass_ == 1:
                return np.nan
            ms = timing.get((r.seed, r.lone, r.color))
            return ms[int(r.own_idx)] if ms is not None and int(r.own_idx) < len(ms) else np.nan
        t = t.rename(columns={"pass": "pass_"})
        t["ms"] = [ms_of(r) for r in t.itertuples()]
        turns.append(t)
        seats.append(s)
    return pd.concat(turns, ignore_index=True), pd.concat(seats, ignore_index=True)


def boot(seed_values):
    v = np.asarray(seed_values, dtype=float)
    v = v[~np.isnan(v)]
    if len(v) < 5:
        return (np.nan, np.nan, np.nan, len(v))
    idx = RNG.integers(0, len(v), size=(B, len(v)))
    means = v[idx].mean(axis=1)
    return (v.mean(), np.percentile(means, 2.5), np.percentile(means, 97.5), len(v))


def game_diff(df, col):
    """Per seed: mean over that seed's games of (Blokee-seat mean − Pentobi-seat mean)."""
    g = df.groupby(["seed", "lone", "engine"])[col].mean().unstack("engine")
    if "blokee" not in g or "pentobi" not in g:
        return pd.Series(dtype=float)
    d = (g["blokee"] - g["pentobi"]).dropna()
    return d.groupby(level="seed").mean()


def seat_diff(df, col):
    """Per seed: Blokee mean minus Pentobi mean, for rows already restricted to one seat."""
    g = df.groupby(["seed", "engine"])[col].mean().unstack("engine")
    return (g["blokee"] - g["pentobi"]).dropna()


def fmt(x, nd=2):
    return "" if x is None or (isinstance(x, float) and np.isnan(x)) else f"{x:.{nd}f}"


def ci(stat, nd=2):
    m, lo, hi, n = stat
    if np.isnan(m):
        return "n/a"
    star = "" if lo <= 0 <= hi else " *"
    return f"{m:+.{nd}f} [{lo:+.{nd}f}, {hi:+.{nd}f}]{star}"


def table(header, rows):
    out = ["| " + " | ".join(header) + " |", "|" + "|".join(["---"] + ["---:"] * (len(header) - 1)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out)


def round_panel(t, s):
    """Per (block, seed, lone, seat, round 0..21): squares placed before the turn, squares placed on
    the turn (0 if no move), legal moves (0 once stuck), able to move, carried past the game's end."""
    rows = []
    keycols = ["block", "seed", "lone", "seat", "color", "engine", "is_lone"]
    t2 = t.set_index(keycols + ["round"])
    final = s.set_index(keycols)["squares_placed"]
    idx = pd.MultiIndex.from_tuples([k + (r,) for k in final.index for r in range(22)], names=keycols + ["round"])
    p = pd.DataFrame(index=idx)
    p["squares_before"] = t2["squares_before"].reindex(idx)
    p["legal"] = t2["legal"].reindex(idx).fillna(0)
    p["own_corners"] = t2["own_corners"].reindex(idx)
    p["own_live"] = t2["own_live"].reindex(idx)
    p["territory"] = t2["territory"].reindex(idx)
    p["placed_now"] = t2["size"].reindex(idx).fillna(0)
    p["reach_after"] = t2["own_min_centre_after"].reindex(idx)
    p = p.reset_index()
    p["reach_after"] = p.groupby(keycols)["reach_after"].ffill()
    fin = final.reset_index().rename(columns={"squares_placed": "final_sq"})
    p = p.merge(fin, on=keycols)
    p["squares_before"] = p["squares_before"].fillna(p["final_sq"])
    p["own_corners"] = p["own_corners"].fillna(0)
    p["own_live"] = p["own_live"].fillna(0)
    p["can_move"] = (p["legal"] > 0).astype(float)
    return p


def main():
    t, s = load()
    mv = t[t.pass_ == 0].copy()
    for c in ["piece", "size", "nu_local", "local_any", "local_attach", "mv"]:
        mv[c] = mv[c].astype(int)
    mv["book"] = ((mv.engine == "pentobi") & (mv.ms < 1.0) & (mv.own_idx <= 10)).astype(float)
    mv["searched_blokee"] = ((mv.engine == "blokee") & (mv.ms > 5.0)).astype(float)
    p = round_panel(t, s)
    out = []
    P = out.append

    P("## Tables\n")
    P("Every difference is **Blokee − Pentobi**, computed within each game (Blokee-seat mean minus "
      "Pentobi-seat mean), averaged over the four seat rotations of a seed, with a bootstrap-by-seed "
      "95% interval (100 seeds, 2,000 resamples). `*` marks an interval that excludes 0. "
      "l6a = one Blokee among three Pentobis; l6b = one Pentobi among three Blokees.\n")

    # ---- headline -----------------------------------------------------------------------------
    s["first_stuck_round_or21"] = s["first_stuck_round"].where(s.all_placed == 0, 21)
    s["stuck_before_r15"] = ((s.all_placed == 0) & (s.first_stuck_round < 15)).astype(float)
    hl = [
        ("Final score", s, "score", 2),
        ("Squares placed (of 89)", s, "squares_placed", 2),
        ("Pieces placed (of 21)", s, "pieces_placed", 2),
        ("All 21 placed (rate)", s, "all_placed", 3),
        ("First round with no move (21 if all placed)", s, "first_stuck_round_or21", 2),
        ("Stuck before round 15 (rate)", s, "stuck_before_r15", 3),
    ]
    mvcols = [
        ("Piece size, own moves 0–6", mv[mv.own_idx <= 6], "size", 3),
        ("Piece size, own moves 7–13", mv[(mv.own_idx >= 7) & (mv.own_idx <= 13)], "size", 3),
        ("Piece size, own moves 14–20", mv[mv.own_idx >= 14], "size", 3),
        ("Centre distance of placement, own moves 0–6", mv[mv.own_idx <= 6], "centre", 3),
        ("Legal moves before own moves 3–12", mv[(mv.own_idx >= 3) & (mv.own_idx <= 12)], "legal", 1),
        ("Own open corners after own moves 3–12", mv[(mv.own_idx >= 3) & (mv.own_idx <= 12)], "own_corners_after", 2),
        ("Opp. corners covered per move, own moves 3–15", mv[(mv.own_idx >= 3) & (mv.own_idx <= 15)], "opp_cover", 3),
        ("Opp. live corners killed per move, 3–15", mv[(mv.own_idx >= 3) & (mv.own_idx <= 15)], "opp_live_killed", 3),
        ("Opp. legal moves removed per move, 3–15", mv[(mv.own_idx >= 3) & (mv.own_idx <= 15)], "opp_legal_cut", 1),
        ("Local response (Pentobi def.), own moves 3–15", mv[(mv.own_idx >= 3) & (mv.own_idx <= 15)], "local_any", 3),
        ("Base rate: share of legal moves that are local, 3–15", mv[(mv.own_idx >= 3) & (mv.own_idx <= 15)], "legal_local_frac", 3),
        ("Covers an opp. attach point itself, 3–15", mv[(mv.own_idx >= 3) & (mv.own_idx <= 15)], "local_attach", 3),
        ("Pentobi local weight nu_local, 3–15", mv[(mv.own_idx >= 3) & (mv.own_idx <= 15)], "nu_local", 2),
        ("Territory before move, own moves 3–12", mv[(mv.own_idx >= 3) & (mv.own_idx <= 12)], "territory", 2),
    ]
    for b in ["l6a", "l6b"]:
        P(f"### Headline, {b}\n")
        rows = []
        for name, df, col, nd in hl + mvcols:
            d = df[df.block == b]
            bm = d[d.engine == "blokee"][col].mean()
            pm = d[d.engine == "pentobi"][col].mean()
            rows.append([name, fmt(bm, nd), fmt(pm, nd), ci(boot(game_diff(d, col)), nd)])
        P(table(["Measure", "Blokee", "Pentobi", "Blokee − Pentobi [95% CI]"], rows) + "\n")

    # ---- by own-move index --------------------------------------------------------------------
    cols = [("size", "size", 2), ("legal", "legal", 0), ("own_corners", "corners", 1), ("own_corners_after", "corners after", 1),
            ("opp_cover", "opp cov", 2), ("opp_live_killed", "opp killed", 2), ("opp_legal_cut", "opp legal cut", 0),
            ("local_any", "local", 2), ("legal_local_frac", "local base", 2), ("squares_before", "sq before", 1),
            ("centre", "centre (mean cell)", 2), ("piece_min_centre", "piece reach", 2)]
    for b in ["l6a", "l6b"]:
        d = mv[mv.block == b]
        P(f"### By own-move index (moves made only), {b}\n")
        P("Each cell is Blokee / Pentobi. Rows are conditional on the seat still having a move at that index; "
          "`n` is Blokee / Pentobi moves. Squares before is the seat's cumulative squares at that move.\n")
        rows = []
        for k in range(21):
            dk = d[d.own_idx == k]
            bk, pk = dk[dk.engine == "blokee"], dk[dk.engine == "pentobi"]
            r = [k, f"{len(bk)} / {len(pk)}"]
            for col, _, nd in cols:
                r.append(f"{fmt(bk[col].mean(), nd)} / {fmt(pk[col].mean(), nd)}")
            rows.append(r)
        P(table(["k", "n"] + [c[1] for c in cols], rows) + "\n")
        P(f"Differences with intervals, {b} (Blokee − Pentobi, within game):\n")
        rows = []
        for k in range(21):
            dk = d[d.own_idx == k]
            rows.append([k] + [ci(boot(game_diff(dk, c)), nd) for c, nd in [("size", 2), ("legal", 0), ("own_corners_after", 1), ("opp_live_killed", 2), ("local_any", 2)]])
        P(table(["k", "size", "legal", "own corners after", "opp live killed", "local response"], rows) + "\n")

    # ---- by round (unconditional) and the decomposition -----------------------------------------
    for b in ["l6a", "l6b"]:
        d = p[p.block == b]
        P(f"### By round, unconditional, {b}\n")
        P("Round r = the seat's r-th turn (passes count as turns; a seat that is stuck stays stuck). "
          "Values after a seat is stuck or the game has ended: legal 0, squares carried forward. "
          "`placed at r` is the squares the seat placed on that turn (0 if it passed); its Blokee − Pentobi "
          "gap summed over rounds is exactly the squares-placed gap. `cum gap` is that running sum.\n")
        rows = []
        cum = 0.0
        for r in range(22):
            dr = d[d["round"] == r]
            gaps = {c: boot(game_diff(dr, c)) for c in ["legal", "squares_before", "placed_now", "can_move", "own_live", "territory", "reach_after"]}
            cum += gaps["placed_now"][0]
            bb, pp = dr[dr.engine == "blokee"], dr[dr.engine == "pentobi"]
            rows.append([r,
                         f"{bb.legal.mean():.0f} / {pp.legal.mean():.0f}", ci(gaps["legal"], 0),
                         f"{bb.own_live.mean():.1f} / {pp.own_live.mean():.1f}", ci(gaps["own_live"], 1),
                         f"{bb.can_move.mean():.2f} / {pp.can_move.mean():.2f}", ci(gaps["can_move"], 3),
                         f"{bb.squares_before.mean():.1f} / {pp.squares_before.mean():.1f}",
                         ci(gaps["placed_now"], 2), f"{cum:+.2f}",
                         f"{bb.territory.mean():.1f} / {pp.territory.mean():.1f}", ci(gaps["territory"], 1),
                         f"{bb.reach_after.mean():.2f} / {pp.reach_after.mean():.2f}", ci(gaps["reach_after"], 2)])
        P(table(["r", "legal B / P", "legal gap", "live corners B / P", "live gap", "can move B / P", "can-move gap", "sq before B / P", "placed at r gap", "cum gap",
                 "territory B / P", "territory gap", "reach after B / P", "reach gap"], rows) + "\n")
        P("`territory` is the engine's Voronoi territory estimate (fractional ties) at the seat's turn (stuck seats keep being measured); "
          "`reach after` is the smallest Manhattan distance from the board centre (9.5, 9.5) of any own cell after the seat's move in that round (lower = deeper toward the centre).\n")
        # Phase decomposition of the squares gap: rounds 0–4, 5–9, 10–14, 15–21; and size vs stuck parts.
        P(f"Phase decomposition of the squares-placed gap, {b}. Within a phase, the gap splits exactly into "
          "(a) moves Pentobi made that Blokee did not (Blokee stuck), valued at Pentobi's mean piece size there, and "
          "(b) the remainder (piece size chosen, given a move, and Blokee moves Pentobi did not make).\n")
        rows = []
        for lo, hi in [(0, 4), (5, 9), (10, 14), (15, 21)]:
            dr = d[(d["round"] >= lo) & (d["round"] <= hi)]
            per = dr.groupby(["seed", "lone", "seat", "engine"]).agg(placed=("placed_now", "sum"), moves=("can_move", "sum")).reset_index()
            g_placed = boot(game_diff(per, "placed"))
            g_moves = boot(game_diff(per, "moves"))
            dm = mv[(mv.block == b) & (mv["round"] >= lo) & (mv["round"] <= hi)]
            psize = dm[dm.engine == "pentobi"]["size"].mean()
            stuck_part = g_moves[0] * psize
            rows.append([f"{lo}–{hi}", ci(g_placed), ci(g_moves), f"{stuck_part:+.2f}", f"{g_placed[0] - stuck_part:+.2f}"])
        bonus = s[s.block == b].assign(bonus=lambda x: x.score - (x.squares_placed - 89))
        rows.append(["bonus (+15/+20)", ci(boot(game_diff(bonus, "bonus"))), "", "", ""])
        rows.append(["**final score**", ci(boot(game_diff(s[s.block == b], "score"))), "", "", ""])
        P(table(["rounds", "squares placed gap", "moves made gap", "(a) ≈ fewer moves × Pentobi size", "(b) remainder (size choice)"], rows) + "\n")

    # ---- stuck and pieces left ----------------------------------------------------------------
    for b in ["l6a", "l6b"]:
        d = s[s.block == b]
        P(f"### When seats first get stuck, and pieces left, {b}\n")
        rows = []
        for eng in ["blokee", "pentobi"]:
            e = d[d.engine == eng]
            fr = e[e.all_placed == 0].first_stuck_round
            q = np.percentile(fr, [10, 25, 50, 75, 90])
            rows.append([eng, len(e), f"{e.all_placed.mean():.3f}", f"{fr.mean():.2f}", " / ".join(f"{x:.0f}" for x in q),
                         f"{e.left_size1.mean():.2f}", f"{e.left_size2.mean():.2f}", f"{e.left_size3.mean():.2f}", f"{e.left_size4.mean():.2f}", f"{e.left_size5.mean():.2f}",
                         f"{(89 - e.squares_placed).mean():.2f}"])
        P(table(["engine", "seats", "all placed", "first stuck round (mean, not all placed)", "p10/p25/p50/p75/p90", "left 1sq", "left 2sq", "left 3sq", "left 4sq", "left 5sq", "squares left"], rows) + "\n")
        rows = [[f"left size {k}", ci(boot(game_diff(d, f"left_size{k}")))] for k in range(1, 6)]
        rows.append(["first stuck round (21 if all placed)", ci(boot(game_diff(d, "first_stuck_round_or21")))])
        P(table(["Blokee − Pentobi", "[95% CI]"], rows) + "\n")
        hist = []
        for eng in ["blokee", "pentobi"]:
            e = d[d.engine == eng]
            fr = e.first_stuck_round_or21
            hist.append([eng] + [f"{(fr == r).mean():.3f}" for r in range(10, 22)] + [f"{(fr < 10).mean():.3f}"])
        P("Distribution of the first round with no move (21 = all pieces placed):\n")
        P(table(["engine"] + [str(r) for r in range(10, 22)] + ["<10"], hist) + "\n")

    # ---- per seat position --------------------------------------------------------------------
    for b in ["l6a", "l6b"]:
        P(f"### Per seat position, {b}\n")
        P("Within one seat colour: Blokee rows at that seat minus Pentobi rows at that seat, per seed (different games of the same seed).\n")
        rows = []
        for c in SEATS:
            ds = s[(s.block == b) & (s.color == c)]
            pr = p[(p.block == b) & (p.color == c)]
            dm = mv[(mv.block == b) & (mv.color == c)]
            r = [c, f"{ds[ds.engine=='blokee'].score.mean():.2f} / {ds[ds.engine=='pentobi'].score.mean():.2f}", ci(boot(seat_diff(ds, "score"))),
                 ci(boot(seat_diff(ds, "squares_placed"))), ci(boot(seat_diff(ds, "first_stuck_round_or21")))]
            for rr in [5, 10, 15]:
                r.append(ci(boot(seat_diff(pr[pr["round"] == rr], "legal")), 0))
            dmm = dm[(dm.own_idx >= 3) & (dm.own_idx <= 15)]
            r.append(ci(boot(seat_diff(dmm, "local_any")), 3))
            r.append(ci(boot(seat_diff(dm[dm.own_idx <= 6], "size")), 2))
            rows.append(r)
        P(table(["seat", "score B / P", "score gap", "squares gap", "first-stuck-round gap", "legal gap r5", "legal gap r10", "legal gap r15", "local-response gap (3–15)", "size gap (0–6)"], rows) + "\n")

    # ---- Blokee among Pentobis vs among Blokees -------------------------------------------------
    P("### The same engine among Pentobis vs among Blokees (same seeds)\n")
    P("Blokee: lone seat in l6a (among three Pentobis) vs the three Blokee seats in l6b. "
      "Pentobi: the three Pentobi seats in l6a vs the lone seat in l6b. Seat-balanced means; the gap is "
      "l6a − l6b per seed, bootstrapped.\n")
    rows = []
    def env_gap(eng, df, col):
        a = df[(df.block == "l6a") & (df.engine == eng)].groupby("seed")[col].mean()
        bb = df[(df.block == "l6b") & (df.engine == eng)].groupby("seed")[col].mean()
        return (a - bb).dropna()
    mid = mv[(mv.own_idx >= 3) & (mv.own_idx <= 15)]
    measures = [("score", s, "score", 2), ("squares placed", s, "squares_placed", 2), ("first stuck round (21 = all)", s, "first_stuck_round_or21", 2),
                ("legal at round 10", p[p["round"] == 10], "legal", 0), ("live corners at round 10", p[p["round"] == 10], "own_live", 2),
                ("opp live corners killed per move (3–15)", mid, "opp_live_killed", 3), ("local response (3–15)", mid, "local_any", 3),
                ("piece size, moves 0–6", mv[mv.own_idx <= 6], "size", 3)]
    for name, df, col, nd in measures:
        for eng in ["blokee", "pentobi"]:
            a = df[(df.block == "l6a") & (df.engine == eng)][col].mean()
            bb = df[(df.block == "l6b") & (df.engine == eng)][col].mean()
            rows.append([name, eng, fmt(a, nd), fmt(bb, nd), ci(boot(env_gap(eng, df, col)), nd)])
    P(table(["measure", "engine", "in l6a", "in l6b", "l6a − l6b [95% CI]"], rows) + "\n")

    # ---- damage received and targeting --------------------------------------------------------
    long = []
    for tgt in range(4):
        x = mv[mv.seat != tgt][["block", "seed", "lone", "seat", "engine", "round", f"kill{tgt}", f"cut{tgt}"]].copy()
        x = x.rename(columns={"seat": "mover", "engine": "mover_engine", f"kill{tgt}": "kill", f"cut{tgt}": "cut"})
        x["target"] = tgt
        long.append(x)
    long = pd.concat(long, ignore_index=True)
    eng_of = s.set_index(["block", "seed", "lone", "seat"])["engine"]
    long["target_engine"] = eng_of.reindex(pd.MultiIndex.from_frame(long[["block", "seed", "lone", "target"]])).values
    long["phase"] = pd.cut(long["round"], [-1, 9, 14, 30], labels=["0–9", "10–14", "15+"])
    for b in ["l6a", "l6b"]:
        d = long[long.block == b]
        P(f"### Damage received, {b}\n")
        P("Live corners of a seat killed (and its legal placements removed) by all other seats' moves, summed per seat per game, by the round of the move. "
          "Gap = Blokee seat − Pentobi seat within game.\n")
        rows = []
        for ph in ["0–9", "10–14", "15+"]:
            per = d[d.phase == ph].groupby(["seed", "lone", "target", "target_engine"]).agg(kill=("kill", "sum"), cut=("cut", "sum")).reset_index().rename(columns={"target_engine": "engine"})
            bb, pp = per[per.engine == "blokee"], per[per.engine == "pentobi"]
            rows.append([ph, f"{bb.kill.mean():.2f} / {pp.kill.mean():.2f}", ci(boot(game_diff(per, "kill"))), f"{bb.cut.mean():.0f} / {pp.cut.mean():.0f}", ci(boot(game_diff(per, "cut")), 0)])
        P(table(["rounds", "live corners lost B / P", "gap", "legal moves removed B / P", "gap"], rows) + "\n")
        P(f"Targeting, {b}: mean live corners killed per move on one target seat, by mover and target engine (rounds 3–15).\n")
        dd = d[(d["round"] >= 3) & (d["round"] <= 15)]
        rows = []
        for me in ["blokee", "pentobi"]:
            for te in ["blokee", "pentobi"]:
                x = dd[(dd.mover_engine == me) & (dd.target_engine == te)]
                if len(x):
                    rows.append([me, te, len(x), f"{x.kill.mean():.3f}", f"{x.cut.mean():.1f}"])
        P(table(["mover", "target", "move×target pairs", "live corners killed", "legal moves removed"], rows) + "\n")
        # Within a move, is the lone engine targeted more than the others? (l6a: Pentobi movers; l6b: Blokee movers)
        lone_eng = "blokee" if b == "l6a" else "pentobi"
        other = "pentobi" if b == "l6a" else "blokee"
        x = dd[dd.mover_engine == other]
        per_move = x.groupby(["seed", "lone", "mover", "round", "target_engine"]).kill.mean().unstack("target_engine")
        diff = (per_move[lone_eng] - per_move[other]).dropna()
        st = boot(diff.groupby(level="seed").mean())
        P(f"Within each {other} move: kills on the lone {lone_eng} seat minus mean kills on each other {other} seat: {ci(st, 3)} (n moves = {len(diff)}).\n")

    # ---- piece order --------------------------------------------------------------------------
    for b in ["l6a", "l6b"]:
        d = mv[mv.block == b]
        P(f"### Piece order, {b}\n")
        P("Mean own-move index at which each piece is played (when played), and share of seats that played it. Sorted by Pentobi's mean index.\n")
        g = d.groupby(["piece", "engine"]).own_idx.mean().unstack("engine")
        nseat = s[s.block == b].groupby("engine").size()
        share = d.groupby(["piece", "engine"]).size().unstack("engine") / nseat
        gap = {pc: boot(game_diff(d[d.piece == pc], "own_idx")) for pc in range(21)}
        rows = []
        for pc in g.sort_values("pentobi").index:
            rows.append([PIECES[pc], SIZES[pc], f"{g.loc[pc,'blokee']:.2f}", f"{g.loc[pc,'pentobi']:.2f}", ci(gap[pc]),
                         f"{share.loc[pc,'blokee']:.2f}", f"{share.loc[pc,'pentobi']:.2f}"])
        P(table(["piece", "size", "Blokee idx", "Pentobi idx", "gap [95% CI]", "Blokee played", "Pentobi played"], rows) + "\n")
        # First five moves: which pieces.
        early = d[d.own_idx <= 4]
        fr = early.groupby(["engine", "piece"]).size().unstack("engine").fillna(0)
        fr = fr / fr.sum()
        top = fr.sort_values("pentobi", ascending=False).head(12)
        P(f"Share of own moves 0–4 by piece, {b} (top 12 by Pentobi share):\n")
        P(table(["piece", "Blokee", "Pentobi"], [[PIECES[pc], f"{top.loc[pc,'blokee']:.3f}", f"{top.loc[pc,'pentobi']:.3f}"] for pc in top.index]) + "\n")

    # ---- Pentobi book usage ---------------------------------------------------------------------
    P("### Pentobi opening-book moves (wall time < 1 ms, own move ≤ 10)\n")
    rows = []
    for b in ["l6a", "l6b"]:
        d = mv[(mv.block == b) & (mv.engine == "pentobi")]
        byk = d.groupby("own_idx").book.mean()
        rows.append([b] + [f"{byk.get(k, 0):.2f}" for k in range(9)])
    P(table(["block"] + [f"k={k}" for k in range(9)], rows) + "\n")
    bl = mv[(mv.engine == "blokee")]
    P("Blokee searched moves (ms > 5) by own index: " + ", ".join(f"k{k} {bl[bl.own_idx==k].searched_blokee.mean():.2f}" for k in range(6)) + "\n")

    # ---- judge ---------------------------------------------------------------------------------
    jpath = f"{D}/judge-l7.csv"
    if os.path.exists(jpath):
        j = pd.read_csv(jpath)
        j["match"] = (j.played == j.judged).astype(float)
        j["same_piece"] = (j.p_piece == j.j_piece).astype(float)
        P("### Pentobi level 7 as judge (sampled decisions from l6a)\n")
        P("A fresh `pentobi-gtp --level 7` (book on, seed 1, one thread) is given the game prefix and asked `reg_genmove` "
          "for the same colour. Pentobi-L6 decisions are the control: how often a level-6 move matches level 7. "
          "Interval: bootstrap over decisions (resampled by game seed).\n")
        rows = []
        for lo, hi in [(0, 2), (3, 5), (6, 8), (9, 11), (12, 14), (15, 20), (0, 20)]:
            r = [f"{lo}–{hi}"]
            for eng in ["blokee", "pentobi"]:
                x = j[(j.engine == eng) & (j.own_idx >= lo) & (j.own_idx <= hi)]
                st = boot(x.groupby("seed").match.mean())
                r.append(f"{x.match.mean():.2f} (n={len(x)})")
                r.append(f"{x.same_piece.mean():.2f}")
            rows.append(r)
        P(table(["own idx", "Blokee = L7 move", "Blokee same piece", "Pentobi-L6 = L7 move", "Pentobi-L6 same piece"], rows) + "\n")
        P("When the move differs from level 7's: mean of (played − level 7's choice) on each feature, by engine, own moves 3–15.\n")
        feats = [("size", 2), ("centre", 2), ("own_corners_after", 2), ("own_live_after", 2), ("own_legal_after", 1), ("opp_cover", 2), ("opp_live_killed", 2), ("opp_legal_cut", 1), ("nu_local", 2), ("local_any", 2)]
        rows = []
        for f, nd in feats:
            r = [f]
            for eng in ["blokee", "pentobi"]:
                x = j[(j.engine == eng) & (j.match == 0) & (j.own_idx >= 3) & (j.own_idx <= 15)]
                dd = (x[f"p_{f}"] - x[f"j_{f}"])
                st = boot(dd.groupby(x.seed).mean())
                r.append(f"{x[f'p_{f}'].mean():.{nd}f} vs {x[f'j_{f}'].mean():.{nd}f}")
                r.append(ci(st, nd))
            rows.append(r)
        nb = len(j[(j.engine == 'blokee') & (j.match == 0) & (j.own_idx >= 3) & (j.own_idx <= 15)])
        npn = len(j[(j.engine == 'pentobi') & (j.match == 0) & (j.own_idx >= 3) & (j.own_idx <= 15)])
        P(table(["feature", f"Blokee played vs L7 (n={nb})", "Blokee − L7", f"Pentobi-L6 played vs L7 (n={npn})", "L6 − L7"], rows) + "\n")
        P(f"Judge wall time: mean {j.judge_ms.mean():.0f} ms per position.\n")
        spath = f"{D}/judge-shortlist.csv"
        if os.path.exists(spath):
            sl = pd.read_csv(spath)
            d = j.merge(sl, on=["seed", "lone", "ply"])
            d = d[d.source == "Search"]
            P("### Is level 7's move even among Blokee's root candidates?\n")
            P("Each judged position re-searched by `v4.2-ultra` (budget 300, a fresh RNG seeded from seed and ply). "
              "`candidates` = root shortlist size (≤ 40 after the tier-1 funnel of 96 and the hand ordering); "
              "`L7 move listed` = level 7's move is in that list (it can be chosen at all); `re-search = played` = the re-search's top move "
              "equals the move actually played (for Blokee rows: Blokee's own repeatability; for Pentobi rows: Blokee agreeing with Pentobi-L6). "
              "Positions searched only (own moves ≥ 3, packer and heuristic decisions excluded).\n")
            rows = []
            for lo, hi in [(3, 5), (6, 8), (9, 11), (12, 14), (15, 20), (3, 20)]:
                r = [f"{lo}–{hi}"]
                for eng in ["blokee", "pentobi"]:
                    x = d[(d.engine == eng) & (d.own_idx >= lo) & (d.own_idx <= hi)]
                    r += [len(x), f"{x.legal.mean():.0f}", f"{x.candidates.mean():.1f}", ci(boot(x.groupby("seed").judged_in_list.mean()), 2).replace(" *", ""), f"{x.research_top_is_played.mean():.2f}"]
                rows.append(r)
            P(table(["own idx", "Blokee n", "legal", "candidates", "L7 move listed [CI]", "re-search = played",
                     "Pentobi n", "legal", "candidates", "L7 move listed [CI]", "re-search = played"], rows) + "\n")
            m = d[(d.engine == "blokee") & (d.played != d.judged)]
            listed = m[m.judged_in_list == 1]
            P(f"Blokee decisions that differ from level 7 (searched, n={len(m)}): level 7's move was in Blokee's root list in {m.judged_in_list.mean():.2f}; "
              f"when listed it received a median {listed.judged_visits.median():.0f} visits in the re-search against a mean {m.top_visits.mean():.0f} for the top move.\n")

    print("\n".join(out))


if __name__ == "__main__":
    main()
