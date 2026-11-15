"""Round 7 B read-out: scaling diagnosis table. python3 engine-rs/scripts/v54_scaling.py tmp/v54/B"""
import csv, os, re, sys
from collections import defaultdict

root = sys.argv[1]
mean = lambda v: sum(v) / len(v) if v else float("nan")
shape = defaultdict(lambda: defaultdict(list))
for r in csv.DictReader(open(os.path.join(root, "shape.csv"))):
    c = r["config"]
    for k in ("iterations", "depth_mean", "depth_max", "root_top_share", "nodes_total", "ms"):
        shape[c][k].append(float(r[k]))
    pv1, pv2 = float(r["pv1"]), float(r["pv2"])
    if pv1 > 0:
        shape[c]["reply_share"].append(pv2 / pv1)
names = ["l6", "l6half", "l6x4", "l6x4half", "pro", "prohalf"]
best = defaultdict(dict)
cost = defaultdict(lambda: defaultdict(list))
for r in csv.DictReader(open(os.path.join(root, "cost.csv"))):
    n = names[int(r["config"])]
    best[n][r["pos"]] = r["best"]
    cost[n]["ms"].append(float(r["ms"]))
    cost[n]["it"].append(float(r["iterations"]))
def change(full, half):
    ps = [p for p in best[full] if p in best[half]]
    return sum(best[full][p] != best[half][p] for p in ps) / len(ps) if ps else float("nan")
reuse = {}
for n in ("l6", "l6x4", "pro"):
    p = os.path.join(root, f"reuse-{n}.md")
    if os.path.exists(p):
        for line in open(p):
            if line.startswith("| all |"):
                cells = [x.strip() for x in line.strip().strip("|").split("|")]
                reuse[n] = (cells[7], cells[6])
print("| Budget (iterationScale) | iterations (mean) | ms/move (1 thread, under ultra load) | iterations/s | nodes | depth mean / max | chosen move's visit share | its top reply's share | best move changes, half → full budget | reuse at next own turn (share of budget; visits) |")
print("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
for n, half, label in (("l6", "l6half", "v5.2-l6 (23.222)"), ("l6x4", "l6x4half", "4× l6 (92.888)"), ("pro", "prohalf", "v5.2-pro (224.487)")):
    s = shape[n]; c = cost[n]
    ips = mean(c["it"]) / (mean(c["ms"]) / 1000)
    ru = reuse.get(n, ("—", "—"))
    print(f"| {label} | {mean(c['it']):,.0f} | {mean(c['ms']):.0f} | {ips:,.0f} | {mean(s['nodes_total']):,.0f} | {mean(s['depth_mean']):.2f} / {max(s['depth_max']):.0f} | "
          f"{mean(s['root_top_share']):.3f} | {mean(s['reply_share']):.3f} | {100 * change(n, half):.1f}% | {ru[0]} ({ru[1]}) |")
print()
for n in ("l6", "pro"):
    p = os.path.join(root, f"sample-{n}.txt")
    if not os.path.exists(p):
        continue
    txt = open(p, errors="ignore").read()
    m = txt.split("Sort by top of stack, same collapsed")
    if len(m) < 2:
        continue
    rows = []
    for line in m[1].splitlines()[1:]:
        q = re.match(r"\s+(.+?)\s+\(in .+?\)\s+(\d+)$", line) or re.match(r"\s+(.+?)\s+(\d+)$", line)
        if q:
            rows.append((q.group(1).strip(), int(q.group(2))))
        if len(rows) >= 14:
            break
    tot = sum(x[1] for x in rows) or 1
    print(f"**Top of stack, `sample` 25 s, {n}** (share of the samples listed):\n")
    for f, k in rows:
        print(f"- {f[:110]}: {k} ({100 * k / tot:.1f}%)")
    print()
