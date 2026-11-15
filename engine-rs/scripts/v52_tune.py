#!/usr/bin/env python3
"""Round 5, Stage 3: CEM tuner (N10 method, new search space) on v5.1-ultra's cost-neutral continuous settings.
Preregistered 2026-11-15, "round 5, Stage 3" entry.

    python3 engine-rs/scripts/v52_tune.py run --base CONFIG --out tmp/v52/S3 --bin BIN --deadline 07:00
    python3 engine-rs/scripts/v52_tune.py final --out tmp/v52/S3        # writes final.json from the state

Each generation g plays pop candidates (candidate 0 = the current mean) on the same 25 seeds
94,000,000 + 100·g .. + 24, lone seat vs three level-6 seats, shared Pentobi process (training only),
book, budget 300, one game thread per candidate, `slots` candidates at once. Fitness = mean advantage over
the 25 seeds. Elite = top `elite`; mean and sigma move halfway to the elite's mean and standard deviation
(sigma floored at a quarter of its start). Coordinates: log for positive scales, linear otherwise, clipped
to the bounds. A generation starts only if the previous generation's wall time fits before the deadline.
The final point (the mean after the last completed generation) is written to final.json. Resumable: state
after every generation; blokee-pentobi skips finished seed/seat pairs.
"""
import argparse
import copy
import datetime
import json
import math
import os
import random
import subprocess
import sys
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(REPO, "ml", "seat"))
from paired_report import load  # noqa: E402

PENTOBI = os.path.expanduser("~/src/pentobi-build/pentobi_gtp/pentobi-gtp")
BOOK = os.path.expanduser("~/src/pentobi/opening_books/book_classic.blksgf")
SEEDS, ORIGIN, STRIDE = 25, 94_000_000, 100

# name, config path, transform, lo, hi
DIMS = [
    ("raveWeight", "native.rave.weight", "log", 0.25, 3.0),
    ("raveEquivalence", "native.rave.equivalence", "log", 20.0, 600.0),
    ("raveDecay", "native.rave.distanceDecay", "lin", 0.0, 1.0),
    ("exploration", "native.selection.exploration", "log", 0.1, 1.2),
    ("qualityWeight", "native.reward.qualityWeight", "lin", 0.0, 1.2),
    ("qualitySlope", "native.reward.qualitySlope", "log", 0.3, 3.0),
    ("lengthWeight", "native.reward.lengthWeight", "lin", 0.0, 0.4),
    ("firstWeight", "native.reward.firstWeight", "lin", 0.0, 0.5),
    ("priorTemperature", "native.candidates.temperature", "log", 0.5, 2.0),
    ("rootInitVisits", "native.candidates.initVisits", "log", 1.0, 10.0),
    ("interiorInitVisits", "native.candidates.interiorInitVisits", "log", 0.5, 6.0),
    ("historyWeight", "search.historyWeight", "log", 0.05, 2.0),
    ("playoutEps", "search.playoutEps", "lin", 0.3, 0.9),
]


def now():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log(m):
    print(f"[{now()}] {m}", flush=True)


DEFAULTS = {"native.candidates.temperature": 1.0, "native.reward.firstWeight": 0.0}


def get(cfg, path):
    x = cfg
    for k in path.split("."):
        if not isinstance(x, dict) or k not in x:
            return DEFAULTS[path]
        x = x[k]
    return float(x)


def put(cfg, path, v):
    ks = path.split(".")
    x = cfg
    for k in ks[:-1]:
        x = x.setdefault(k, {})
    x[ks[-1]] = v


def to_x(name, v):
    d = next(d for d in DIMS if d[0] == name)
    return math.log(v) if d[2] == "log" else v


def bounds(d):
    return (math.log(d[3]), math.log(d[4])) if d[2] == "log" else (d[3], d[4])


def config_of(base, x):
    c = copy.deepcopy(base)
    for d, xi in zip(DIMS, x):
        lo, hi = bounds(d)
        xi = min(hi, max(lo, xi))
        v = math.exp(xi) if d[2] == "log" else xi
        put(c, d[1], round(v, 5))
    return c


def fitness(path):
    if not os.path.exists(path):
        return float("-inf")
    adv = load(path)
    if len(adv) < SEEDS:
        return float("-inf")
    return sum(adv.values()) / len(adv)


def run_generation(args, g, cands):
    gdir = os.path.join(args.out, f"gen-{g:02d}")
    os.makedirs(gdir, exist_ok=True)
    base_seed = ORIGIN + STRIDE * g
    procs = []
    pending = list(range(len(cands)))
    active = {}
    while pending or active:
        while pending and len(active) < args.slots:
            i = pending.pop(0)
            cfgp = os.path.join(gdir, f"c{i:02d}.json")
            json.dump(cands[i], open(cfgp, "w"), indent=1)
            out = os.path.join(gdir, f"c{i:02d}.jsonl")
            if fitness(out) > float("-inf"):
                continue
            cmd = [args.bin, "--blokee", cfgp, "--pentobi", PENTOBI, "--book", BOOK, "--mode", "one-blokee",
                   "--level", "6", "--budget", "300", "--threads", "1", "--seeds", str(SEEDS), "--seed-base", str(base_seed),
                   "--label", f"t{g:02d}-c{i:02d}", "--out", out]
            lf = open(os.path.join(gdir, f"c{i:02d}.log"), "a")
            active[i] = subprocess.Popen(cmd, cwd=REPO, stdout=lf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        time.sleep(2)
        for i, p in list(active.items()):
            if p.poll() is not None:
                del active[i]
    return [fitness(os.path.join(gdir, f"c{i:02d}.jsonl")) for i in range(len(cands))], base_seed


def run(args):
    os.makedirs(args.out, exist_ok=True)
    base = json.load(open(args.base))
    sp = os.path.join(args.out, "state.json")
    if os.path.exists(sp):
        st = json.load(open(sp))
    else:
        mu = [to_x(d[0], get(base, d[1])) for d in DIMS]
        sig = [0.3 if d[2] == "log" else 0.15 * (d[4] - d[3]) for d in DIMS]
        st = {"gen": 0, "mu": mu, "sigma": sig, "sigma0": list(sig), "history": [], "rng": 20261115, "last_wall": 0}
        json.dump(st, open(sp, "w"), indent=1)
    dl_h, dl_m = map(int, args.deadline.split(":"))
    while True:
        t = datetime.datetime.now()
        deadline = t.replace(hour=dl_h, minute=dl_m, second=0, microsecond=0)
        if deadline < t - datetime.timedelta(hours=12):
            deadline += datetime.timedelta(days=1)
        if t + datetime.timedelta(seconds=st["last_wall"]) > deadline:
            log(f"stop: generation {st['gen']} would not finish before {args.deadline} (last wall {st['last_wall']:.0f} s)")
            break
        g = st["gen"]
        rnd = random.Random(st["rng"] + g)
        xs = [list(st["mu"])]
        for _ in range(args.pop - 1):
            xs.append([m + s * rnd.gauss(0, 1) for m, s in zip(st["mu"], st["sigma"])])
        xs = [[min(bounds(d)[1], max(bounds(d)[0], xi)) for d, xi in zip(DIMS, x)] for x in xs]
        cands = [config_of(base, x) for x in xs]
        log(f"generation {g}: {args.pop} candidates on seeds {ORIGIN + STRIDE * g}..+{SEEDS - 1}")
        t0 = time.time()
        fit, seed_base = run_generation(args, g, cands)
        wall = time.time() - t0
        order = sorted(range(len(xs)), key=lambda i: -fit[i])
        elite = [xs[i] for i in order[:args.elite] if fit[i] > float("-inf")]
        if len(elite) < 2:
            log(f"generation {g}: fewer than 2 valid candidates, stopping")
            break
        n = len(elite)
        em = [sum(e[k] for e in elite) / n for k in range(len(DIMS))]
        es = [math.sqrt(sum((e[k] - em[k]) ** 2 for e in elite) / n) for k in range(len(DIMS))]
        st["mu"] = [0.5 * m + 0.5 * e for m, e in zip(st["mu"], em)]
        st["sigma"] = [max(0.25 * s0, 0.5 * s + 0.5 * e) for s, e, s0 in zip(st["sigma"], es, st["sigma0"])]
        st["history"].append({"gen": g, "seed_base": seed_base, "fitness": fit, "mean_fitness": fit[0],
                              "best": max(fit), "wall": round(wall), "mu": st["mu"]})
        st["gen"] = g + 1
        st["last_wall"] = wall
        json.dump(st, open(sp, "w"), indent=1)
        log(f"generation {g} done in {wall:.0f} s: mean-candidate fitness {fit[0]:+.2f}, best {max(fit):+.2f}, "
            f"elite {[round(fit[i], 2) for i in order[:args.elite]]}")
        write_final(args.out, base, st)
    write_final(args.out, base, st)


def write_final(out, base, st):
    c = config_of(base, st["mu"])
    json.dump(c, open(os.path.join(out, "final.json"), "w"), indent=1)
    vals = {d[0]: round(math.exp(x) if d[2] == "log" else x, 4) for d, x in zip(DIMS, st["mu"])}
    json.dump({"generations": st["gen"], "values": vals}, open(os.path.join(out, "final-point.json"), "w"), indent=1)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("--base", default="engine-rs/configs/v5.1-ultra.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--bin", default="tmp/v51d/bin3/blokee-pentobi")
    ap.add_argument("--deadline", default="07:00")
    ap.add_argument("--pop", type=int, default=12)
    ap.add_argument("--elite", type=int, default=4)
    ap.add_argument("--slots", type=int, default=12)
    ap.add_argument("--seeds", type=int, default=SEEDS, help="smoke tests only")
    ap.add_argument("--origin", type=int, default=ORIGIN, help="smoke tests only")
    a = ap.parse_args()
    SEEDS, ORIGIN = a.seeds, a.origin
    if a.cmd == "run":
        run(a)
    elif a.cmd == "final":
        write_final(a.out, json.load(open(a.base)), json.load(open(os.path.join(a.out, "state.json"))))
