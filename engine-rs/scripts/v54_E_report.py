"""Round 7 Stage E read-out. python3 engine-rs/scripts/v54_E_report.py"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from v51c_report import arm_line, paired, merged, roles, fmt_ci

E = "tmp/v54/E/games"
arms = [a for a in ("base", "IIV3-ET", "COMBO-ET") if os.path.exists(f"{E}/e-{a}.jsonl") and os.path.getsize(f"{E}/e-{a}.jsonl")]
print("| Arm | Seeds | Advantage vs three level-7 seats | First place (any) | First place (split) |\n|---|---:|---:|---:|---:|")
for a in arms:
    print(arm_line(a, f"{E}/e-{a}.jsonl"))
print()
for a in arms[1:]:
    n, d, f1, f2 = paired(f"{E}/e-{a}.jsonl", f"{E}/e-base.jsonl")
    rule = ""
    if a == "IIV3-ET":
        ok = n >= 100 and d[1] > 0 and not (f2[2] < 0)
        rule = f" -> {'ACCEPTED' if ok else 'NOT ACCEPTED'} (second confirmation rule)"
    else:
        rule = f" -> {'clears (candidate for a later confirmation)' if d[1] > 0 else 'does not clear'} (screen only)"
    print(f"- {a} − base, {n} seeds: {fmt_ci(d)}; first place (any) {fmt_ci(f1)} pp, (split) {fmt_ci(f2)} pp{rule}")
# pooled IIV3-ET over 99,000,000 + 99,100,000 + 99,300,000 (descriptive)
pa = merged(["tmp/v54/C/screen/rol-IIV3-ET.jsonl", "tmp/v54/C/confirm/rolc-IIV3-ET.jsonl", f"{E}/e-IIV3-ET.jsonl"], "tmp/v54/E/pooled-IIV3-ET.jsonl")
pb = merged(["tmp/v54/C/screen/rol-base.jsonl", "tmp/v54/C/confirm/rolc-base.jsonl", f"{E}/e-base.jsonl"], "tmp/v54/E/pooled-base.jsonl")
n, d, f1, f2 = paired(pa, pb)
print(f"\n- DESCRIPTIVE, not the decision: IIV3-ET − base pooled over {n} seeds (99,000,000 + 99,100,000 + 99,300,000): {fmt_ci(d)}; first place (split) {fmt_ci(f2)} pp")
print()
roles([f"{E}/e-{a}.jsonl" for a in arms])
