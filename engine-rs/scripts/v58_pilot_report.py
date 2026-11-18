#!/usr/bin/env python3
"""Round 11 Step D read-out (descriptive): times, advantages, paired SD and projected Mac hours.

usage: v58_pilot_report.py <pilot dir> [L9/L8 Pentobi ms ratio] [L7/L8 ratio] [C at L9 per arm, "U:2,X:5"] [C at L7 "U:3,X:8"]
Reads <dir>/screen/rol-<arm>.{jsonl,timing.jsonl} for U and PLAYED, <dir>/THREADS, and the chain log for wall time.
"""
import json, math, os, re, sys
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ml", "seat"))
from paired_report import bootstrap, load  # noqa: E402

d = sys.argv[1]
r98 = float(sys.argv[2]) if len(sys.argv) > 2 else 17069.2 / 3931.5   # round 6 calibration, move 5+
r78 = float(sys.argv[3]) if len(sys.argv) > 3 else 902.7 / 3931.5
c9 = dict(kv.split(":") for kv in sys.argv[4].split(",")) if len(sys.argv) > 4 else {}
c7 = dict(kv.split(":") for kv in sys.argv[5].split(",")) if len(sys.argv) > 5 else {}
arm = open(os.path.join(d, "PLAYED")).read().split()[0]
arms = ["U", arm]
threads = {l.split()[0]: int(l.split()[1]) for l in open(os.path.join(d, "THREADS")) if l.strip()}
SEATS = ("blue", "yellow", "purple", "green")

# wall time per chunk-arm from the chain log
wall = {a: 0.0 for a in arms}
log = open(os.path.join(d, "chain.log")).read() if os.path.exists(os.path.join(d, "chain.log")) else ""
for a in arms:
    for k in (0, 1):
        s = re.search(rf"=== pil-{re.escape(a)}-c{k} start (\S+ \S+)", log)
        e = re.search(rf"=== pil-{re.escape(a)}-c{k} done (\S+ \S+)", log)
        if s and e:
            f = "%Y-%m-%d %H:%M:%S"
            wall[a] += (datetime.strptime(e.group(1), f) - datetime.strptime(s.group(1), f)).total_seconds()

print("| Arm | Concurrency | Games | Seeds | Advantage vs L8 [95% CI] | First place (any) | Blokee ms/move own 5+ | Blokee own 3+ | Pentobi ms/move move 5+ | Blokee / Pentobi (5+) | Game seconds (mean) | Blokee s / game | Pentobi s / game | Wall h (both chunks) |")
print("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
info = {}
for a in arms:
    games = [json.loads(l) for l in open(os.path.join(d, "screen", f"rol-{a}.jsonl")) if l.strip()]
    tim = [json.loads(l) for l in open(os.path.join(d, "screen", f"rol-{a}.timing.jsonl")) if l.strip()]
    adv = load(os.path.join(d, "screen", f"rol-{a}.jsonl"))
    m, lo, hi = bootstrap(list(adv.values()))
    fp = sum(g["seat"] in g["winner"] for g in games) / len(games)
    b5 = [x for t in tim for x in t["blokeeMs"][4:]]
    b3 = [x for t in tim for x in t["blokeeMs"][2:]]
    p5 = [x for t in tim for s, v in t["msBySeat"].items() if s != t["seat"] for x in v[4:]]
    bs = sum(sum(t["blokeeMs"]) for t in tim) / len(tim) / 1000
    ps = sum(sum(t["pentobiMs"]) for t in tim) / len(tim) / 1000
    gs = sum(t["gameSeconds"] for t in tim) / len(tim)
    info[a] = dict(adv=adv, bs=bs, ps=ps, gs=gs, n=len(games))
    mb, mp = sum(b5) / len(b5), sum(p5) / len(p5)
    print(f"| {a} | {threads[a]} | {len(games)} | {len(adv)} | {m:+.2f} [{lo:+.2f}, {hi:+.2f}] | {fp * 100:.1f}% | {mb:,.0f} | {sum(b3) / len(b3):,.0f} | {mp:,.0f} | {mb / mp:.3f} | {gs:,.0f} | {bs:,.0f} | {ps:,.0f} | {wall[a] / 3600:.2f} |")
common = sorted(set(info["U"]["adv"]) & set(info[arm]["adv"]))
delta = [info[arm]["adv"][s] - info["U"]["adv"][s] for s in common]
m, lo, hi = bootstrap(delta)
sd = math.sqrt(sum((x - m) ** 2 for x in delta) / (len(delta) - 1))
print(f"\nPaired Δ ({arm} − U) on {len(common)} seeds: {m:+.2f} [{lo:+.2f}, {hi:+.2f}]; per-seed SD of Δ {sd:.2f}.")
for a in arms:
    v = list(info[a]["adv"].values()); mm = sum(v) / len(v)
    print(f"Per-seed SD of {a}'s advantage: {math.sqrt(sum((x - mm) ** 2 for x in v) / (len(v) - 1)):.2f}")


def hours(a, n, pent_ratio, conc):
    """Steady-state hours for n seeds (4 games each) of arm a at concurrency conc."""
    g = info[a]["bs"] + info[a]["ps"] * pent_ratio + (info[a]["gs"] - info[a]["bs"] - info[a]["ps"])
    return 4 * n * g / conc / 3600


print(f"\nProjection (steady state: 4 games per seed × mean game seconds / concurrency; Pentobi time scaled by L9/L8 = {r98:.2f}, L7/L8 = {r78:.3f}):\n")
print("| Block | Seeds | Hours, U | Hours, " + arm + " | Hours, both arms | 95% half-width of paired Δ at pilot SD |")
print("|---|---:|---:|---:|---:|---:|")
for n in (50, 100, 200, 400, 800):
    hu, hx = hours("U", n, 1, threads["U"]), hours(arm, n, 1, threads[arm])
    print(f"| L8 screen | {n} | {hu:.1f} | {hx:.1f} | {hu + hx:.1f} | ±{1.96 * sd / math.sqrt(n):.2f} |")
for n in (24, 50, 100):
    if c9:
        hu, hx = hours("U", n, r98, int(c9["U"])), hours(arm, n, r98, int(c9[arm]))
        print(f"| L9 block | {n} | {hu:.1f} | {hx:.1f} | {hu + hx:.1f} | ±{1.96 * sd / math.sqrt(n):.2f} (L8 SD) |")
if c7:
    for a in arms:
        print(f"| L7 anchor, one arm ({a}) | 50 | | | {hours(a, 50, r78, int(c7[a])):.1f} | — |")
pilot_wall = sum(wall.values()) / 3600
print(f"\nPilot wall time, both arms: {pilot_wall:.2f} h for 12 seeds (includes start-up and tail of each 24-game chunk).")
