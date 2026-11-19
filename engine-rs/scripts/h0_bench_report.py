"""Hybrid H0 gate G4: Markdown tables from `engine-rs/scripts/h0-bench.sh`'s rows.csv (stdlib only).

    python3 engine-rs/scripts/h0_bench_report.py tmp/h0/bench/rows.csv > tmp/h0/bench/report.md

One table per backend label: per batch size and mode, µs per position (median call / batch) and positions
per second, with the median call in µs and its 10th-90th percentile range; then the first call at each
batch size (cold shape) and the session setup time.
"""

import csv
import sys
from collections import defaultdict

MODES = ["device", "host", "e2e"]
TITLES = {"device": "network on GPU-resident inputs", "host": "+ host-device copies", "e2e": "+ Rust encoding, from positions"}


def main() -> None:
    rows = list(csv.DictReader(open(sys.argv[1])))
    by_label: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_label[r["label"]].append(r)
    for label, items in by_label.items():
        backend = items[0]["backend"]
        setup = [r for r in items if r["mode"] == "setup"]
        data = {(r["mode"], int(r["batch"])): r for r in items if r["mode"] != "setup"}
        modes = [m for m in MODES if any(k[0] == m for k in data)]
        batches = sorted({k[1] for k in data})
        print(f"#### {label}\n\n`{backend}`; setup (library load + session) {float(setup[0]['first_ms']):.0f} ms\n" if setup else f"#### {label}\n")
        header = "| batch | " + " | ".join(f"{m}: µs/pos | {m}: pos/s | {m}: call µs (p10–p90)" for m in modes) + " | first call ms (" + ", ".join(modes) + ") |"
        print(header)
        print("|" + "---|" * (1 + 3 * len(modes) + 1))
        for b in batches:
            cells = []
            firsts = []
            for m in modes:
                r = data.get((m, b))
                if r is None:
                    cells += ["", "", ""]
                    firsts.append("")
                    continue
                cells += [f"{float(r['us_per_position']):.1f}", f"{float(r['positions_per_s']):,.0f}",
                          f"{float(r['median_us']):,.0f} ({float(r['p10_us']):,.0f}–{float(r['p90_us']):,.0f})"]
                firsts.append(f"{float(r['first_ms']):.1f}")
            print(f"| {b} | " + " | ".join(cells) + " | " + ", ".join(firsts) + " |")
        print()
    print("Modes: " + "; ".join(f"`{m}` {TITLES[m]}" for m in MODES) + ".")


if __name__ == "__main__":
    main()
