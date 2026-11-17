"""Round 10 pro read-out (prereg 2026-11-17, "Round 10" in research_paper/v5_1_candidates_results.md).
    python3 engine-rs/scripts/v57_pro_report.py

The decision is v51b_report.py --roll-confirm tmp/v57/pro 800 (confirm.md): W1D-ET is accepted if its paired
advantage difference vs base over the 800 seeds 102,000,000-102,000,799 has a 95% bootstrap lower bound above 0
and its paired first-place interval is not entirely below 0. This script adds, descriptively: the in-match time
check (W1D-ET / base, own moves 3+, band 0.97-1.03), the per-chunk differences, and the pooled numbers with
round 9's 300 seeds (101,500,000) and round 8's 100 (100,300,000), which are selection-biased screen data.
Complete seeds only (all four rotations), paired by seed, bootstrap over seeds.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ml", "seat"))
from v51c_report import arm_line, paired, merged, roles, fmt_ci  # noqa: E402
from s4_report import timing  # noqa: E402

D = "tmp/v57/pro"
R9 = "tmp/v56/pro/screen"
R8 = "tmp/v55/W/pro/screen"
ARM = "W1D-ET"
C = lambda a: f"{D}/confirm/rolc-{a}.jsonl"

print("## Round 10 confirmation block (102,000,000-102,000,799), vs three level-7 seats\n")
print("| Arm | Seeds | Advantage vs three level-7 seats | First place (any) | First place (split) |\n|---|---:|---:|---:|---:|")
for a in ("base", ARM):
    print(arm_line(a, C(a)))
n, d, f1, f2 = paired(C(ARM), C("base"))
ok = d[1] > 0 and not (f1[2] < 0)
print(f"\n- {ARM} − base, {n} seeds: {fmt_ci(d)}; first place (any) {fmt_ci(f1)} pp, (split) {fmt_ci(f2)} pp "
      f"-> {'ACCEPTED' if ok and n >= 800 else 'NOT ACCEPTED'}{'' if n >= 800 else ' (incomplete)'}")

ta, la = timing(C("base")[:-6] + ".timing.jsonl")
tw, lw = timing(C(ARM)[:-6] + ".timing.jsonl")
print(f"\nIn-match ms/move, all 8 chunks (CONTAMINATED: chunk 0 ran through battery throttling from about 10:12 and a "
      f"low-power sleep 10:58-12:24, amendment 1): base {ta:.1f} / {la:.1f}; {ARM} {tw:.1f} / {lw:.1f} (all / own moves 3+); ratio (3+) {lw / la:.3f}")
# The equal-time check (amendment 1): clean chunks 1-7 only, both arms.
os.makedirs(f"{D}/pooled", exist_ok=True)
clean = {a: merged([f"{D}/chunks/rol-{a}-c{k}.timing.jsonl" for k in range(1, 8) if os.path.exists(f"{D}/chunks/rol-{a}-c{k}.done")],
                   f"{D}/pooled/clean-{a}.timing.jsonl") for a in ("base", ARM)}
ta, la = timing(clean["base"])
tw, lw = timing(clean[ARM])
r = lw / la
print(f"In-match ms/move, clean chunks 1-7 (the equal-time check): base {ta:.1f} / {la:.1f}; {ARM} {tw:.1f} / {lw:.1f}; "
      f"ratio (3+) {r:.3f} -> {'inside' if 0.97 <= r <= 1.03 else 'OUTSIDE'} 0.97-1.03")

print("\n## Per chunk (descriptive)\n")
print("| Chunk | Seeds | base | W1D-ET | Paired Δ [95% CI] | Δ first place (any), pp | ms/move 3+ base / W1D-ET |\n|---|---|---:|---:|---:|---:|---:|")
for k in range(8):
    a, b = f"{D}/chunks/rol-{ARM}-c{k}.jsonl", f"{D}/chunks/rol-base-c{k}.jsonl"
    if not (os.path.exists(f"{D}/chunks/rol-{ARM}-c{k}.done") and os.path.exists(f"{D}/chunks/rol-base-c{k}.done")):
        continue
    n, d, f1, _ = paired(a, b)
    ab = arm_line("x", b).split(" | ")[2]
    aw = arm_line("x", a).split(" | ")[2]
    tb = timing(b[:-6] + ".timing.jsonl")[1]
    tw = timing(a[:-6] + ".timing.jsonl")[1]
    print(f"| c{k} | {102000000 + 100 * k:,}+ | {ab} | {aw} | {fmt_ci(d)} | {fmt_ci(f1)} | {tb:.0f} / {tw:.0f} |")

print("\n## DESCRIPTIVE, not the decision: pooled with round 9's 300 seeds and round 8's 100 (screen data, selection-biased)\n")
os.makedirs(f"{D}/pooled", exist_ok=True)
sets = {
    "round 10 + round 9 (1,100 seeds)": [R9, f"{D}/confirm"],
    "round 10 + round 9 + round 8 (1,200 seeds)": [R8, R9, f"{D}/confirm"],
}
print("| Sample | Seeds | base | W1D-ET | Paired Δ [95% CI] | Δ first place (any), pp [95% CI] |\n|---|---:|---:|---:|---:|---:|")
for i, (name, dirs) in enumerate(sets.items()):
    p = {}
    for a in ("base", ARM):
        files = [f"{x}/{'rolc' if x.endswith('confirm') else 'rol'}-{a}.jsonl" for x in dirs]
        p[a] = merged(files, f"{D}/pooled/s{i}-{a}.jsonl")
    n, d, f1, _ = paired(p[ARM], p["base"])
    print(f"| {name} | {n} | {arm_line('x', p['base']).split(' | ')[2]} | {arm_line('x', p[ARM]).split(' | ')[2]} | {fmt_ci(d)} | {fmt_ci(f1)} |")

print("\n## Score relative to the game mean by position relative to the lone seat\n")
roles([C("base"), C(ARM)])
