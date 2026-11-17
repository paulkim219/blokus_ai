"""Round 9 pro read-out (prereg 2026-11-16, "round 9" entry). python3 engine-rs/scripts/v56_pro_report.py

The 300-seed block 101,500,000 (base, W1A-ET, W1D-ET vs three level-7 seats) alone: a screen; an arm clears if
its paired difference vs base has a lower bound above 0, and a clearing arm is confirmed in a later round.
Then, descriptive only, the same arms pooled with round 8's 100 seeds 100,300,000 (tmp/v55/W/pro/screen/).
Complete seeds only (all four rotations), paired by seed, bootstrap over seeds.
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
from v51c_report import arm_line, paired, merged, roles, fmt_ci  # noqa: E402

D = "tmp/v56/pro"
R8 = "tmp/v55/W/pro/screen"
arms = [a for a in ("base", "W1A-ET", "W1D-ET") if os.path.exists(f"{D}/screen/rol-{a}.jsonl") and os.path.getsize(f"{D}/screen/rol-{a}.jsonl")]

print("## This block alone (101,500,000–101,500,299), screen\n")
sys.stdout.flush()
subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "v51b_report.py"), "--roll-screen", D])
print()
print("| Arm | Seeds | Advantage vs three level-7 seats | First place (any) | First place (split) |\n|---|---:|---:|---:|---:|")
for a in arms:
    print(arm_line(a, f"{D}/screen/rol-{a}.jsonl"))
print()
for a in arms[1:]:
    n, d, f1, f2 = paired(f"{D}/screen/rol-{a}.jsonl", f"{D}/screen/rol-base.jsonl")
    v = "clears (confirmation in a later round)" if d[1] > 0 else "does not clear"
    print(f"- {a} − base, {n} seeds: {fmt_ci(d)}; first place (any) {fmt_ci(f1)} pp, (split) {fmt_ci(f2)} pp -> {v}")

print("\n## DESCRIPTIVE, not the decision: pooled with round 8's 100 seeds 100,300,000\n")
os.makedirs(f"{D}/pooled", exist_ok=True)
pooled = {a: merged([f"{R8}/rol-{a}.jsonl", f"{D}/screen/rol-{a}.jsonl"], f"{D}/pooled/rol-{a}.jsonl") for a in arms}
print("| Arm | Seeds | Advantage vs three level-7 seats | First place (any) | First place (split) |\n|---|---:|---:|---:|---:|")
for a in arms:
    print(arm_line(a, pooled[a]))
print()
for a in arms[1:]:
    n, d, f1, f2 = paired(pooled[a], pooled["base"])
    print(f"- {a} − base, pooled over {n} seeds: {fmt_ci(d)}; first place (any) {fmt_ci(f1)} pp, (split) {fmt_ci(f2)} pp")
print()
roles([f"{D}/screen/rol-{a}.jsonl" for a in arms])
