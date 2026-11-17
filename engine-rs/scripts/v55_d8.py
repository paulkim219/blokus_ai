"""Round 8 D8 read-out (amendment 2026-11-16 16:20): W1A at equal iterations (EI) vs the confirmation block's
base and W1A-ET arms, paired by seed. python3 engine-rs/scripts/v55_d8.py tmp/v55/W/<tier>"""
import os
import sys
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ml", "seat"))
from p910_report import paired_lines, fmt_ci  # noqa: E402
from paired_report import load, bootstrap  # noqa: E402
from s4_report import timing  # noqa: E402

d = os.path.join(sys.argv[1], "confirm")
p = lambda a: os.path.join(d, f"{a}.jsonl")
ei, base, et = p("d8-W1A-EI"), p("rolc-base"), p("rolc-W1A-ET")
print(f"W1A-EI alone: {len(load(ei))} seeds, advantage {fmt_ci(bootstrap(list(load(ei).values())))}; in-match ms/move 3+ {timing(ei[:-6] + '.timing.jsonl')[1]:.1f} (base {timing(base[:-6] + '.timing.jsonl')[1]:.1f}, W1A-ET {timing(et[:-6] + '.timing.jsonl')[1]:.1f})")
for name, other in (("W1A-EI - base", base), ("W1A-ET - W1A-EI", None)):
    if other is None:
        dm, fp, n = paired_lines(et, ei)
    else:
        dm, fp, n = paired_lines(ei, other)
    print(f"- {name}: {fmt_ci(dm)} on {n} seeds; first place {fmt_ci(fp)} pp")
