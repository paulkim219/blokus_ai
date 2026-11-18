# High-budget round (2026-11-17/18 CST) — results

Plan of record: `research_paper/v5_high_budget_plan.md` (copied unchanged, commit `2e53ecc`). Branch `v5-high-budget` from `v6-native-engine-e4` at `d5b6771`, worktree `/Users/paulkim/Blokee-hb`. Raw output: `/Users/paulkim/Blokee/tmp/hb/` (untracked). Local commits only.

**Machine.** Round 10 (pid 28488, `tmp/v57/`) uses all 14 cores until about 06:00–06:30. Until it exits this round runs no match and no timing or cost measurement. It runs builds, tests, identity checks, offline log analysis and single-threaded probes under `nice -n 20`. Each is logged with start and end times in `tmp/hb/cpu-log.txt`. Clean timing happens only in the quiet slot after pid 28488 exits (at most 45 minutes, ending with `touch tmp/hb/QUIET_DONE`, at 07:00 at the latest).

**Seeds.** No game is played tonight. Round 10's block 102,000,000–102,000,799 and its reserved blocks (102,160,000; 102,180,000) are not used for selection or analysis. Development positions come from completed earlier games only (rounds 6–9 logs listed per experiment).

---

## §3 Lazy interior child allocation — preregistration (2026-11-17 21:10 CST, this commit's time; fixed before any identity, memory or speed figure is read)

**Mechanism.** Option `native.candidates.interiorCap.lazy` (bool, absent = false = today's eager layout; engine `engine-rs/src/search.rs`). It takes effect only with an interior cap. An interior node keeps its full prior-sorted `moves` and `priors`. It holds `children`, `child_visits` and the AMAF pairs only for edges [0, d), where d is the largest window `select` has opened at that node. When the window grows, the arrays grow (capacity ×1.5, never past the move count). AMAF credit for an edge at or beyond d goes to a sparse pending list, sorted by edge, as (sum, weight) pairs built from the same additions in the same order. The pair moves into the dense slot unchanged when the window reaches its edge. Interior AMAF updates find a move's edge by binary search in a per-node edge permutation sorted by move id (2 bytes per edge). Eager mode scans every edge instead; both give the same credits. The root stays eager. Refused with `native.net`, whose depth-1 policy re-sorts a root child's moves.

**Why identity should be exact.** Selection reads only edges below the window, and their children, visits and AMAF pairs are the eager values bit for bit. Each placement occurs at most once in a simulation, so each slot gets at most one addition per simulation, with the same weight expression in the same order. Edges beyond the window are never read until the window opens. Update order, transpositions and tie-breaking are untouched.

**Identity gates (all must hold; any failure is reported and lazy is not used):**
1. *Option absent = round-9 binary.* The new build against `tmp/v56/bin`:
   - `s4_identity`, 180 positions (`tmp/d1/x1-l6a.moves.jsonl`) × v5.2-nano, v5.2-lite, v5.2, v5.2-turbo, v5.3-nano, v5.3-lite, v5.3, v5.3-turbo: byte-identical output;
   - `blokee-match` v5.3-turbo vs v5.2-turbo, 2 seeds × 4 rotations from 80,900,000, one thread: identical result lines (moves via scores, plies, winners);
   - `v55_speed` digests at pro (`pro-base`, `pro-W1D-ET`) on the probe positions below: all equal.
2. *Lazy = eager at fixed iterations with the same cap:*
   - `tests/lazy.rs`: 45 searches (3 caps × 3 RAVE settings × 5 positions, about 1,000 iterations): ranked root (move, visits, value bits) and tree shape equal, lazy tree bytes lower;
   - `s4_identity` 180 positions × v5.3-{nano,lite,base,turbo} eager vs `-lazy`: identical lines;
   - `v55_speed` digests at pro (`pro-W1D-ET` vs `pro-W1D-ET-lazy`) and at ultra (`ultra-W1D` vs `ultra-W1D-lazy`): all equal.

**Memory (load-insensitive, run while round 10 plays, one thread, `nice -n 20`).** `v55_speed` on `tmp/d1/x1-l6a.moves.jsonl` (round 8's set: 150 positions, own moves 3+). Pro searches every 3rd position (50). Ultra searches every 30th (5), because a search there takes about 21 s quiet and 8 GB. Reported per arm: tree heap bytes per iteration, the largest tree, and peak RSS from `/usr/bin/time -l`. The arms are `pro-W1D-ET` vs `pro-W1D-ET-lazy`, and `ultra-W1D` (v5.2-ultra plus cap {16, 4}, not re-timed, probe only) vs `ultra-W1D-lazy`.

**Speed (quiet slot only).** `p4_cost`, one thread, pro, 60 positions of `tmp/d1/x1-l6a.moves.jsonl`. Order: an unscored warm-up search by `pro-W1D-ET`, then the two arms, in two rounds with the order reversed (round 9's warm-up procedure). The figure is the mean ms ratio lazy / eager. If time allows: `v55_speed` at ultra on the 5 positions, both arms in turn.

**What the outcome decides (fixed now).** No match is played on it tonight.
- Identity passes and lazy is at most 0.97× eager's clean ms at pro: the saving can buy iterations. A later screen would play `W1D-ET-lazy` with `iterationScale` / cost against the W1D-ET or v5.2-pro control (whichever round 10 leaves as control). That screen is preregistered below, not run.
- Identity passes and the cost lies in 0.97–1.03: lazy plays the same games in the same time. It is a memory option only, usable for ultra benchmark capacity, with no strength claim.
- Identity passes and the cost is above 1.03: memory option only, with the slowdown stated.
- Identity fails: the reason is documented precisely, decision agreement is measured against a 1%-more-iterations noise reference (round 9 probe style), and lazy is not used.
