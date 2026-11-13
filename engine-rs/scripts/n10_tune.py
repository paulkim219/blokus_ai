#!/usr/bin/env python3
"""N10: cross-entropy-method (CEM) re-fit of engine config weights, fitness against Pentobi level 6.

    python3 engine-rs/scripts/n10_tune.py live     --base CONFIG --bin BIN --out tmp/n10 [--threads T]
    python3 engine-rs/scripts/n10_tune.py run      --base CONFIG --bin BIN --out tmp/n10 --threads T \\
                                                   --pop 20 --elite 5 --seeds-per-candidate 10 \\
                                                   --generations G --deadline HH:MM
    python3 engine-rs/scripts/n10_tune.py validate --start CONFIG --tuned tmp/n10/n10-final.json \\
                                                   [--extra CONFIG] --bin BIN --out tmp/n10/validate --threads T
    python3 engine-rs/scripts/n10_tune.py score    FILE.jsonl     # advantage [95% CI], as aggregateMatches.ts

Fitness = challenger advantage (Blokee seat score − mean of the three Pentobi seats, averaged over the
four seat rotations of a seed, then over seeds), exactly as scripts/aggregateMatches.ts and
ml/seat/paired_report.py define it; the bootstrap is paired_report's port of scripts/lib/stats.ts.

Match settings are S1's (engine-rs/scripts/s1-screen.sh): --mode one-blokee --level 6 --budget 300,
Pentobi with its Classic book. Each subcommand copies --bin once into <out>/bin (sha256 in
PROVENANCE.txt) and refuses a different binary later, so a resumed run never mixes engines.

Seeds: generation g plays 81,000,000 + g*1000 .. + seeds_per_candidate − 1 (same seeds for every
candidate of a generation, never reused). Seeds >= 81,900,000 are reserved for liveness (81,900,000)
and smoke tests (--seed-origin 81950000, validate --seeds 1 --seed-base 81960000). Validation seeds
79,800,000–79,800,199 are one-shot (preregistered); `validate` refuses to replay complete results.

Resumability: `run` keeps the distribution and RNG state in <out>/state.json after every completed
generation and the sampled candidates in <out>/gen-XX/candidates.json; rerunning the same command
continues from the last completed generation, re-samples the in-progress generation (and checks it
equals the saved one), and lets blokee-pentobi skip seed/seat pairs already in each candidate's JSONL.
SIGTERM/SIGINT kill the match processes this script started (their process groups) and exit.
"""
import argparse
import copy
import datetime
import hashlib
import json
import math
import os
import random
import shutil
import signal
import statistics
import subprocess
import sys
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(REPO, "ml", "seat"))
from paired_report import bootstrap  # noqa: E402

SEATS = ("blue", "yellow", "purple", "green")
PHASES = ("opening", "midgame", "endgame")
ORDER_NAMES = ("pieceSize", "split", "newCorners", "denyCorners", "centrePull")
WEIGHT_NAMES = ("squares", "corners", "territory", "waste", "centre", "frontier", "oppTerritory",
                "oppCorners", "oppSquares", "mobility", "uniqueCorners", "cornerExponent")
SEARCH_NAMES = ("cPuct", "priorTemp", "playoutEps", "rankBlend", "evalScale", "historyWeight",
                "wideningGrowth", "playoutTableBlend")
UNIT_INTERVAL = {"playoutEps", "rankBlend", "playoutTableBlend"}
# Natural-unit hard bounds for positive search knobs (log-tuned); all are f64 in config.rs, which has
# no numeric range checks for them, so these only keep the search sane (priorTemp is clamped at 1e-6,
# cPuct/wideningGrowth/evalScale must stay > 0 to mean anything).
SEARCH_BOUNDS = {"cPuct": (0.05, 20.0), "priorTemp": (0.25, 100.0), "evalScale": (1.0, 500.0),
                 "historyWeight": (0.01, 20.0), "wideningGrowth": (0.05, 10.0)}
LOG_SIGMA, UNIT_SIGMA, LIN_SIGMA = 0.25, 0.1, 0.25
LOG_SPAN = math.log(8.0)          # ordering weights and multipliers: start × [1/8, 8]
MAX_DIMS = 24
LIVE_SEED = 81_900_000
SEED_ORIGIN = 81_000_000
RESERVED_FROM = 81_900_000
VALIDATE_SEEDS, VALIDATE_BASE = 200, 79_800_000
SMOOTH, SIGMA_FLOOR = 0.5, 0.2
PENTOBI = os.path.expanduser("~/src/pentobi-build/pentobi_gtp/pentobi-gtp")
BOOK = os.path.expanduser("~/src/pentobi/opening_books/book_classic.blksgf")

RUNNING = {}   # pid -> Popen, match processes this script started


# ---------------------------------------------------------------- small utilities

def now():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log(msg):
    print(f"[{now()}] {msg}", flush=True)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def write_text(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def lines(path):
    """Parsed JSONL records; a torn last line (process killed mid-write) is skipped."""
    out = []
    if not os.path.exists(path):
        return out
    for line in open(path):
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return out


def repair_jsonl(path):
    """Drop unparsable lines so blokee-pentobi's resume reads a clean file."""
    if not os.path.exists(path):
        return
    raw = open(path).read().splitlines()
    good = []
    for line in raw:
        try:
            json.loads(line)
            good.append(line)
        except json.JSONDecodeError:
            pass
    if len(good) != len([l for l in raw if l.strip()]) or (raw and not open(path).read().endswith("\n")):
        write_text(path, "".join(l + "\n" for l in good))


def advantage_by_seed(path):
    """seed -> advantage; same definition as paired_report.load (complete rotations only)."""
    by_seed = {}
    for g in lines(path):
        s, seat = g["scores"], g["seat"]
        others = [s[c] for c in SEATS if c != seat]
        by_seed.setdefault(g["seed"], {})[seat] = s[seat] - sum(others) / len(others)
    return {seed: sum(v.values()) / 4 for seed, v in by_seed.items() if len(v) == 4}


def stem(path):
    return path[:-len(".jsonl")] if path.endswith(".jsonl") else path


def failures(jsonl):
    p = stem(jsonl) + ".failures.jsonl"
    return os.path.exists(p) and os.path.getsize(p) > 0


def flatten(x, prefix=""):
    if isinstance(x, dict):
        out = {}
        for k, v in x.items():
            out.update(flatten(v, f"{prefix}{k}."))
        return out
    return {prefix[:-1]: x}


# ---------------------------------------------------------------- binary pinning and match jobs

def pin_binary(out, bin_path):
    pinned = os.path.join(out, "bin", "blokee-pentobi")
    src = os.path.abspath(bin_path)
    if not os.path.isfile(src):
        sys.exit(f"--bin {bin_path}: not a file")
    if os.path.exists(pinned):
        if os.path.abspath(pinned) != src and sha256(pinned) != sha256(src):
            sys.exit(f"{pinned} exists with a different sha256 than --bin {bin_path}; refusing to mix engines "
                     f"(pass --bin {pinned} to continue with the pinned copy)")
        return pinned
    os.makedirs(os.path.dirname(pinned), exist_ok=True)
    shutil.copy2(src, pinned)
    try:
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True).stdout.strip()
    except OSError:
        head = "?"
    write_text(os.path.join(out, "bin", "PROVENANCE.txt"),
               f"{now()}\ncopied from {src}\n{sha256(pinned)}  {pinned}\nrepo HEAD {head}\n")
    return pinned


def kill_running(*_):
    for p in list(RUNNING.values()):
        try:
            os.killpg(p.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    deadline = time.time() + 5
    for p in list(RUNNING.values()):
        try:
            p.wait(max(0.1, deadline - time.time()))
        except subprocess.TimeoutExpired:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
    RUNNING.clear()


def on_signal(signum, _frame):
    log(f"signal {signum}: stopping match processes started by this script")
    kill_running()
    sys.exit(128 + signum)


def complete_seeds(jsonl, seeds, seed_base):
    adv = advantage_by_seed(jsonl)
    return sum(1 for s in range(seed_base, seed_base + seeds) if s in adv)


def status_path(jsonl):
    return stem(jsonl) + ".status.json"


def run_jobs(jobs, args, slots):
    """Each job: config, out, label, seeds, seed_base, threads, moves (bool). At most `slots` processes
    at once. Finished jobs (complete JSONL, or a recorded exit status) are not relaunched."""
    pending = []
    for j in jobs:
        st = status_path(j["out"])
        if os.path.exists(st):
            continue
        if complete_seeds(j["out"], j["seeds"], j["seed_base"]) == j["seeds"]:
            write_json(st, {"exit": 0, "finished": now(), "note": "complete on disk"})
            continue
        repair_jsonl(j["out"])
        pending.append(j)
    active = {}
    while pending or active:
        while pending and len(active) < slots:
            j = pending.pop(0)
            cmd = [args.bin_pinned, "--blokee", j["config"], "--pentobi", args.pentobi, "--book", args.book,
                   "--mode", "one-blokee", "--level", str(args.level), "--budget", str(args.budget),
                   "--threads", str(j["threads"]), "--seeds", str(j["seeds"]), "--seed-base", str(j["seed_base"]),
                   "--label", j["label"], "--out", j["out"]]
            if j.get("moves"):
                cmd += ["--moves-out", stem(j["out"]) + ".moves.jsonl"]
            logf = open(stem(j["out"]) + ".log", "a")
            logf.write(f"[{now()}] {' '.join(cmd)}\n")
            logf.flush()
            p = subprocess.Popen(cmd, cwd=REPO, stdout=logf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                 start_new_session=True)
            logf.close()
            RUNNING[p.pid] = p
            active[p.pid] = (p, j, time.time())
        time.sleep(1.0)
        for pid, (p, j, t0) in list(active.items()):
            code = p.poll()
            if code is None:
                continue
            del active[pid]
            RUNNING.pop(pid, None)
            n = complete_seeds(j["out"], j["seeds"], j["seed_base"])
            write_json(status_path(j["out"]), {"exit": code, "finished": now(), "wall": round(time.time() - t0, 1),
                                               "completeSeeds": n})
            if code != 0 or n != j["seeds"] or failures(j["out"]):
                log(f"FAILED {j['label']}: exit {code}, {n}/{j['seeds']} complete seeds"
                    f"{', failures.jsonl present' if failures(j['out']) else ''}")


def job_ok(jsonl, seeds, seed_base):
    st = status_path(jsonl)
    if not os.path.exists(st) or json.load(open(st)).get("exit") != 0 or failures(jsonl):
        return False
    return complete_seeds(jsonl, seeds, seed_base) == seeds


def fitness(jsonl, seeds, seed_base):
    if not job_ok(jsonl, seeds, seed_base):
        return float("-inf")
    adv = advantage_by_seed(jsonl)
    return sum(adv[s] for s in range(seed_base, seed_base + seeds)) / seeds


def game_seconds(paths):
    """(games, thread-seconds) from timing files written beside each JSONL (gameSeconds per game)."""
    games, secs = 0, 0.0
    for p in paths:
        for t in lines(stem(p) + ".timing.jsonl"):
            if "gameSeconds" in t:
                games += 1
                secs += t["gameSeconds"]
    return games, secs


# ---------------------------------------------------------------- the search space

def get_path(cfg, path):
    x = cfg
    for k in path.split("."):
        if not isinstance(x, dict) or k not in x:
            return None
        x = x[k]
    return x


def set_path(cfg, path, value):
    keys = path.split(".")
    x = cfg
    for k in keys[:-1]:
        x = x[k]
    x[keys[-1]] = value


def make_dim(name, kind, start, paths, log_bounds=None, lin_bounds=None, unit=False):
    """Dimension in tuned coordinates: log (x = ln value) or linear (x = value)."""
    if unit:
        return dict(name=name, kind=kind, paths=paths, start=start, transform="linear",
                    x0=float(start), sigma0=UNIT_SIGMA, lo=0.0, hi=1.0)
    if start > 0:
        lo, hi = log_bounds
        lo, hi = min(lo, start), max(hi, start)
        return dict(name=name, kind=kind, paths=paths, start=start, transform="log",
                    x0=math.log(start), sigma0=LOG_SIGMA, lo=math.log(lo), hi=math.log(hi))
    lo, hi = lin_bounds
    lo, hi = min(lo, start), max(hi, start)
    return dict(name=name, kind=kind, paths=paths, start=start, transform="linear",
                x0=float(start), sigma0=LIN_SIGMA, lo=lo, hi=hi)


def candidate_dims(base):
    """All candidate dimensions in the fixed priority order; missing paths are reported and skipped."""
    dims, skipped = [], []
    for p in ("opening", "midgame"):
        for n in ORDER_NAMES:
            path = f"ordering.{p}.{n}"
            v = get_path(base, path)
            if not isinstance(v, (int, float)):
                skipped.append(path)
                continue
            lin = (0.0, 8.0) if v >= 0 else (4.0 * v, 0.0)
            dims.append(make_dim(path, "ordering", float(v), [path], (v / 8.0, v * 8.0) if v > 0 else None, lin))
    for n in WEIGHT_NAMES:
        paths = [f"phases.{p}.{n}" for p in PHASES]
        if any(not isinstance(get_path(base, q), (int, float)) for q in paths):
            skipped.append(f"mult.{n}")
            continue
        dims.append(make_dim(f"mult.{n}", "mult", 1.0, paths, (1 / 8.0, 8.0)))
    for n in SEARCH_NAMES:
        path = f"search.{n}"
        v = get_path(base, path)
        if not isinstance(v, (int, float)):
            skipped.append(path)
            continue
        if n in UNIT_INTERVAL:
            dims.append(make_dim(path, "search", float(v), [path], unit=True))
        else:
            dims.append(make_dim(path, "search", float(v), [path], SEARCH_BOUNDS[n], (0.0, SEARCH_BOUNDS[n][1])))
    return dims, skipped


def natural(dim, x):
    if x == dim["x0"]:
        return dim["start"]   # exp(ln v) != v in floating point; keep the start config bit-exact
    x = min(dim["hi"], max(dim["lo"], x))
    return math.exp(x) if dim["transform"] == "log" else x


def apply(base, dims, xs):
    cfg = copy.deepcopy(base)
    for d, x in zip(dims, xs):
        v = natural(d, x)
        if d["kind"] == "mult":
            for path in d["paths"]:
                set_path(cfg, path, get_path(base, path) * v)
        else:
            set_path(cfg, d["paths"][0], v)
    return cfg


def nat_bounds(d):
    return (math.exp(d["lo"]), math.exp(d["hi"])) if d["transform"] == "log" else (d["lo"], d["hi"])


def load_base(path):
    return json.load(open(path)), sha256(path)


def common_args(p, base_required=True):
    if base_required:
        p.add_argument("--base", required=True, help="starting config JSON")
    p.add_argument("--bin", required=True, help="blokee-pentobi binary (copied once into OUT/bin)")
    p.add_argument("--out", required=True, help="output directory (e.g. tmp/n10)")
    p.add_argument("--threads", type=int, default=2, help="max concurrent match processes / threads (default 2)")
    p.add_argument("--pentobi", default=PENTOBI)
    p.add_argument("--book", default=BOOK)
    p.add_argument("--level", type=int, default=6)
    p.add_argument("--budget", type=int, default=300)


# ---------------------------------------------------------------- live

def cmd_live(args):
    out = args.out
    os.makedirs(os.path.join(out, "live"), exist_ok=True)
    if os.path.exists(os.path.join(out, "state.json")) and not args.force:
        sys.exit(f"{out}/state.json exists: tuning has started, the space is fixed (use --force to redo liveness)")
    args.bin_pinned = pin_binary(out, args.bin)
    base, base_sha = load_base(args.base)
    dims, skipped = candidate_dims(base)
    if args.only:
        wanted = [s.strip() for s in args.only.split(",") if s.strip()]
        unknown = [w for w in wanted if w not in {d["name"] for d in dims}]
        if unknown:
            sys.exit(f"--only: unknown dimensions {unknown}")
        dims = [d for d in dims if d["name"] in wanted]
    ldir = os.path.join(out, "live")
    write_json(os.path.join(ldir, "base.json"), base)
    write_json(os.path.join(ldir, "base-repeat.json"), base)
    jobs = [dict(config=os.path.join(ldir, f"{n}.json"), out=os.path.join(ldir, f"{n}.jsonl"), label=f"n10-live-{n}",
                 seeds=1, seed_base=LIVE_SEED, threads=1, moves=True) for n in ("base", "base-repeat")]
    for d in dims:
        x = d["x0"] + d["sigma0"]
        if x > d["hi"]:
            x = d["x0"] - d["sigma0"]
        d["live_x"] = x
        xs = [dd["x0"] for dd in dims]
        xs[dims.index(d)] = x
        cfg = apply(base, dims, xs)
        changed = {k for k, v in flatten(cfg).items() if flatten(base)[k] != v}
        expected = set(d["paths"]) if d["kind"] != "mult" else {p for p in d["paths"] if get_path(base, p) != 0}
        assert changed == expected, f"{d['name']}: changed {sorted(changed)}"
        write_json(os.path.join(ldir, f"{d['name']}.json"), cfg)
        jobs.append(dict(config=os.path.join(ldir, f"{d['name']}.json"), out=os.path.join(ldir, f"{d['name']}.jsonl"),
                         label=f"n10-live-{d['name']}", seeds=1, seed_base=LIVE_SEED, threads=1, moves=True))
    log(f"liveness: {len(jobs)} configs x 1 seed (4 games) from seed {LIVE_SEED}, {args.threads} at a time")
    run_jobs(jobs, args, args.threads)

    def moves(name):
        return {(m["seed"], m["seat"]): m["moves"] for m in lines(os.path.join(ldir, f"{name}.moves.jsonl"))}

    base_moves, rep_moves = moves("base"), moves("base-repeat")
    if len(base_moves) != 4 or base_moves != rep_moves:
        sys.exit(f"liveness aborted: base vs base-repeat not identical ({len(base_moves)} games, "
                 f"{sum(base_moves.get(k) != rep_moves.get(k) for k in base_moves)} differ) — the comparison needs "
                 "deterministic games")
    rows = []
    for d in dims:
        mv = moves(d["name"])
        ok = job_ok(os.path.join(ldir, f"{d['name']}.jsonl"), 1, LIVE_SEED) and len(mv) == 4
        differ = sum(mv.get(k) != base_moves[k] for k in base_moves) if ok else None
        d["live_games_differ"] = differ
        d["live"] = bool(ok and differ > 0)
        rows.append(d)
    chosen = [d for d in dims if d["live"]][:MAX_DIMS]
    g, s = game_seconds([j["out"] for j in jobs])
    stamp = now()
    space = dict(created=stamp, base=os.path.abspath(args.base), base_sha256=base_sha,
                 bin_sha256=sha256(args.bin_pinned), live_seed=LIVE_SEED, only=args.only or None,
                 thread_seconds_per_game=round(s / g, 2) if g else None,
                 dims=[{k: d[k] for k in ("name", "kind", "paths", "start", "transform", "x0", "sigma0", "lo", "hi")}
                       for d in chosen],
                 candidates=[{"name": d["name"], "live": d["live"], "gamesDiffer": d["live_games_differ"]} for d in rows],
                 skipped_missing=skipped)
    write_json(os.path.join(out, "space.json"), space)
    md = [f"# N10 tuning space (fixed {stamp}, before any tuning game)", "",
          f"Starting config: `{args.base}` (sha256 {base_sha[:16]}…). Binary sha256 {space['bin_sha256'][:16]}…",
          f"Liveness: each candidate perturbed by +1 initial sigma (−1 if that leaves the bounds), 1 seed "
          f"({LIVE_SEED}, 4 games), Blokee moves compared with the unperturbed config; base replayed once to "
          f"confirm determinism (identical). Dead = all 4 games move-for-move identical."
          + (f" DEBUG: restricted with --only {args.only}." if args.only else ""), "",
          "## Liveness", "", "| Candidate | Games ≠ base | Live |", "|---|---:|---|"]
    for d in rows:
        md.append(f"| {d['name']} | {d['live_games_differ'] if d['live_games_differ'] is not None else 'failed'}/4 | "
                  f"{'yes' if d['live'] else 'no'} |")
    if skipped:
        md += ["", f"Missing from the config (not candidates): {', '.join(skipped)}"]
    md += ["", f"## Tuned dimensions ({len(chosen)}, priority order, max {MAX_DIMS})", "",
           "Log-transformed dims are sampled as x = ln(value) (multipliers: x = ln(multiplier), start 1, each "
           "multiplying that `phases` weight in all three phases); linear dims as x = value, clipped to bounds.", "",
           "| # | Dimension | Transform | Start | Bounds (natural units) | Initial sigma (tuned units) |",
           "|---:|---|---|---:|---|---:|"]
    for i, d in enumerate(chosen):
        lo, hi = nat_bounds(d)
        md.append(f"| {i} | {d['name']} | {d['transform']} | {d['start']:.6g} | [{lo:.4g}, {hi:.4g}] | {d['sigma0']} |")
    write_text(os.path.join(out, "SPACE-FIXED.md"), "\n".join(md) + "\n")
    print("\n".join(md))
    if g:
        print(f"\nmeasured: {g} games, {s / g:.2f} thread-seconds per game (gameSeconds, 1 engine thread each)")
    log("LIVE DONE")


# ---------------------------------------------------------------- run

def resolve_deadline(hhmm):
    if not hhmm:
        return None
    h, m = (int(v) for v in hhmm.split(":"))
    t = datetime.datetime.now().replace(hour=h, minute=m, second=0, microsecond=0)
    if t <= datetime.datetime.now():
        t += datetime.timedelta(days=1)
    return t


def rng_from(state):
    r = random.Random()
    v, internal, gauss_next = state
    r.setstate((v, tuple(internal), gauss_next))
    return r


def sample(rng, mean, sigma, dims, pop):
    cands = []
    for _ in range(pop):
        cands.append([min(d["hi"], max(d["lo"], m + s * rng.gauss(0.0, 1.0))) for d, m, s in zip(dims, mean, sigma)])
    return cands


def gen_seeds(args, g):
    return args.seed_origin + g * 1000


def write_trace(out, space, state):
    dims = space["dims"]
    md = ["These are selection-biased tuning figures (each generation's own seeds, the best of many candidates), "
          "not results; only the one-shot `validate` on fresh seeds measures the tuned config.", "",
          "## Fitness per generation (advantage vs three Pentobi level-6 seats, mean over that generation's seeds)", "",
          "| Gen | Seeds | Mean-config fitness | Best candidate | Median candidate | Finite/pop | Wall min |",
          "|---:|---|---:|---:|---:|---:|---:|"]
    f = lambda x: f"{x:+.2f}" if x is not None and math.isfinite(x) else "−inf" if x is not None else "—"
    for h in state["history"]:
        md.append(f"| {h['gen']} | {h['seed_base']}+{h['seeds']} | {f(h['mean_fitness'])} | {f(h['best'])} | "
                  f"{f(h['median'])} | {h['finite']}/{h['pop']} | {h.get('wall_min', 0):.1f} |")
    md += ["", "## Distribution after each generation: mean in natural units (sigma in tuned units)", "",
           "| Gen | " + " | ".join(d["name"] for d in dims) + " |", "|---" * (len(dims) + 1) + "|"]
    md.append("| start | " + " | ".join(f"{natural(d, d['x0']):.4g} ({d['sigma0']:.3g})" for d in dims) + " |")
    for h in state["history"]:
        md.append(f"| {h['gen']} | " + " | ".join(f"{natural(d, m):.4g} ({s:.3g})"
                                                 for d, m, s in zip(dims, h["mean_after"], h["sigma_after"])) + " |")
    write_text(os.path.join(out, "trace.md"), "\n".join(md) + "\n")


def finalize(args, base, space, state):
    final = apply(base, space["dims"], state["mean"])
    write_json(os.path.join(args.out, "n10-final.json"), final)
    write_trace(args.out, space, state)
    log(f"wrote {args.out}/n10-final.json (distribution mean after {state['gen_done']} generations) and trace.md")


def cmd_run(args):
    out = args.out
    space_path = os.path.join(out, "space.json")
    if not os.path.exists(space_path):
        sys.exit(f"{space_path} missing: run `live` first (the space is fixed before any tuning game)")
    space = json.load(open(space_path))
    base, base_sha = load_base(args.base)
    if base_sha != space["base_sha256"]:
        sys.exit(f"--base {args.base} differs from the config the space was fixed on ({space['base']})")
    if args.elite < 2 or args.elite > args.pop:
        sys.exit("--elite must be in [2, pop]")
    if args.seeds_per_candidate > 1000:
        sys.exit("--seeds-per-candidate must be <= 1000")
    if args.seed_origin < RESERVED_FROM and args.seed_origin + (args.generations - 1) * 1000 + args.seeds_per_candidate > RESERVED_FROM:
        sys.exit(f"{args.generations} generations would reach the reserved seeds >= {RESERVED_FROM}")
    args.bin_pinned = pin_binary(out, args.bin)
    if sha256(args.bin_pinned) != space["bin_sha256"]:
        log("WARNING: pinned binary differs from the one liveness was measured with")
    dims = space["dims"]
    if not dims:
        sys.exit("space has no tuned dimensions")
    space_sha = sha256(space_path)
    state_path = os.path.join(out, "state.json")
    run_key = dict(pop=args.pop, elite=args.elite, seeds_per_candidate=args.seeds_per_candidate,
                   rng_seed=args.rng_seed, seed_origin=args.seed_origin, space_sha256=space_sha, base_sha256=base_sha)
    if os.path.exists(state_path):
        state = json.load(open(state_path))
        if state["key"] != run_key:
            sys.exit(f"state.json was made with different settings: {state['key']} vs {run_key}")
        log(f"resuming after {state['gen_done']} completed generations")
    else:
        state = dict(key=run_key, gen_done=0, mean=[d["x0"] for d in dims], sigma=[d["sigma0"] for d in dims],
                     rng=list(random.Random(args.rng_seed).getstate()), history=[], created=now())
        write_json(state_path, state)
    deadline = resolve_deadline(args.deadline)
    log(f"run: {len(dims)} dims, pop {args.pop}, elite {args.elite}, {args.seeds_per_candidate} seeds/candidate, "
        f"{args.threads} processes, target {args.generations} generations, deadline {deadline or 'none'}")
    while state["gen_done"] < args.generations:
        if deadline and datetime.datetime.now() >= deadline:
            log("deadline reached: not starting another generation")
            break
        g = state["gen_done"]
        t0 = time.time()
        rng = rng_from(state["rng"])
        mean, sigma = state["mean"], state["sigma"]
        cands = sample(rng, mean, sigma, dims, args.pop)
        gdir = os.path.join(out, f"gen-{g:02d}")
        os.makedirs(gdir, exist_ok=True)
        cpath = os.path.join(gdir, "candidates.json")
        record = dict(gen=g, mean=mean, sigma=sigma, candidates=cands)
        if os.path.exists(cpath):
            saved = json.load(open(cpath))
            if saved["candidates"] != cands or saved["mean"] != mean:
                sys.exit(f"{cpath} differs from the re-sampled generation {g}: state and files disagree")
            log(f"gen {g}: re-sampled candidates identical to {cpath}")
        else:
            write_json(cpath, record)
        seed_base = gen_seeds(args, g)
        jobs = []
        named = [("mean", mean)] + [(f"cand-{i:02d}", c) for i, c in enumerate(cands)]
        for name, xs in named:
            cfg_path = os.path.join(gdir, f"{name}.json")
            write_json(cfg_path, apply(base, dims, xs))
            jobs.append(dict(config=cfg_path, out=os.path.join(gdir, f"{name}.jsonl"), label=f"n10-g{g:02d}-{name}",
                             seeds=args.seeds_per_candidate, seed_base=seed_base, threads=1, moves=False))
        log(f"gen {g}: seeds {seed_base}..{seed_base + args.seeds_per_candidate - 1}, {len(jobs)} configs")
        run_jobs(jobs, args, args.threads)
        fits = [fitness(j["out"], args.seeds_per_candidate, seed_base) for j in jobs]
        mean_fit, cand_fits = fits[0], fits[1:]
        finite = [i for i, v in enumerate(cand_fits) if math.isfinite(v)]
        order = sorted(finite, key=lambda i: (-cand_fits[i], i))
        elites = order[:args.elite]
        if len(elites) >= 2:
            new_mean, new_sigma = [], []
            for k, d in enumerate(dims):
                vals = [cands[i][k] for i in elites]
                em, es = statistics.fmean(vals), statistics.pstdev(vals)
                new_mean.append(SMOOTH * mean[k] + (1 - SMOOTH) * em)
                new_sigma.append(max(SMOOTH * sigma[k] + (1 - SMOOTH) * es, SIGMA_FLOOR * d["sigma0"]))
        else:
            log(f"gen {g}: fewer than 2 finite candidates; distribution unchanged")
            new_mean, new_sigma = list(mean), list(sigma)
        games, secs = game_seconds([j["out"] for j in jobs])
        h = dict(gen=g, seed_base=seed_base, seeds=args.seeds_per_candidate, pop=args.pop,
                 mean_fitness=mean_fit if math.isfinite(mean_fit) else None,
                 best=cand_fits[order[0]] if order else None,
                 median=statistics.median([cand_fits[i] for i in finite]) if finite else None,
                 finite=len(finite), fitness=[v if math.isfinite(v) else None for v in cand_fits], elites=elites,
                 mean_before=mean, sigma_before=sigma, mean_after=new_mean, sigma_after=new_sigma,
                 wall_min=(time.time() - t0) / 60, thread_seconds_per_game=round(secs / games, 2) if games else None,
                 finished=now())
        state.update(gen_done=g + 1, mean=new_mean, sigma=new_sigma, rng=list(rng.getstate()))
        state["history"].append(h)
        write_json(state_path, state)
        write_trace(out, space, state)
        log(f"GEN {g} DONE: mean-config {h['mean_fitness']}, best {h['best']}, median {h['median']}, "
            f"{len(finite)}/{args.pop} finite, {h['wall_min']:.1f} min, {h['thread_seconds_per_game']} thread-s/game")
    finalize(args, base, space, state)
    log("RUN EXIT")


# ---------------------------------------------------------------- validate

def timing_ms(jsonl):
    all_ms, late = [], []
    for t in lines(stem(jsonl) + ".timing.jsonl"):
        all_ms += t.get("blokeeMs", [])
        late += t.get("blokeeMs", [])[3:]
    if not all_ms:
        recs = lines(jsonl)
        secs = sum(r.get("challengerSeconds", 0) for r in recs)
        mv = sum(r.get("challengerMoves", 0) for r in recs)
        return (1000 * secs / mv if mv else None), None
    m = lambda v: sum(v) / len(v) if v else None
    return m(all_ms), m(late)


def cmd_validate(args):
    out = args.out
    os.makedirs(out, exist_ok=True)
    arms = [("start", args.start), ("tuned", args.tuned)] + ([("extra", args.extra)] if args.extra else [])
    paths = {a: os.path.join(out, f"n10v-{a}.jsonl") for a, _ in arms}
    done = all(complete_seeds(p, args.seeds, args.seed_base) == args.seeds for p in paths.values())
    if not args.report_only:
        if done and not args.force:
            sys.exit(f"{out} already has complete results for every config: validation is one-shot "
                     "(use --report-only to print them, --force to run anyway)")
        args.bin_pinned = pin_binary(out, args.bin)
        jobs = []
        for a, cfg in arms:
            c = os.path.join(out, f"n10v-{a}.json")
            if os.path.exists(c) and sha256(c) != sha256(cfg):
                sys.exit(f"{c} exists and differs from {cfg}: refusing to mix configs within one validation")
            shutil.copyfile(cfg, c)
            jobs.append(dict(config=c, out=paths[a], label=f"n10v-{a}", seeds=args.seeds, seed_base=args.seed_base,
                             threads=args.threads, moves=True))
        for j in jobs:
            st = status_path(j["out"])
            if os.path.exists(st) and complete_seeds(j["out"], j["seeds"], j["seed_base"]) != j["seeds"]:
                os.remove(st)   # interrupted earlier: let blokee-pentobi resume it
        log(f"validate: {len(jobs)} configs x {args.seeds} seeds from {args.seed_base}, {args.threads} threads each, "
            "one config at a time")
        run_jobs(jobs, args, 1)
    adv = {a: advantage_by_seed(paths[a]) for a, _ in arms}
    seeds = range(args.seed_base, args.seed_base + args.seeds)
    print(f"| Config | File | Seeds | Advantage vs L{args.level} [95% CI] | ms/move all | ms/move 3+ |")
    print("|---|---|---:|---:|---:|---:|")
    for a, cfg in arms:
        v = [adv[a][s] for s in seeds if s in adv[a]]
        m, lo, hi = bootstrap(v) if v else (float("nan"),) * 3
        t_all, t_late = timing_ms(paths[a])
        fm = lambda x: f"{x:.1f}" if x is not None else "—"
        print(f"| {a} | {cfg} | {len(v)} | {m:+.2f} [{lo:+.2f}, {hi:+.2f}] | {fm(t_all)} | {fm(t_late)} |")
    for other in ("start", "extra"):
        if other not in adv:
            continue
        common = [s for s in seeds if s in adv["tuned"] and s in adv[other]]
        if not common:
            continue
        m, lo, hi = bootstrap([adv["tuned"][s] - adv[other][s] for s in common])
        sig = " *" if len(common) >= 2 and (lo > 1e-6 or hi < -1e-6) else ""
        print(f"\npaired Δ tuned − {other}: {m:+.2f} [95% CI {lo:+.2f}, {hi:+.2f}]{sig} over {len(common)} seeds")
    for a in paths:
        if failures(paths[a]):
            print(f"WARNING: {stem(paths[a])}.failures.jsonl present")
    log("VALIDATE DONE")


# ---------------------------------------------------------------- score

def cmd_score(args):
    for path in args.files:
        adv = advantage_by_seed(path)
        v = list(adv.values())
        m, lo, hi = bootstrap(v)
        print(f"{path}: {len(v)} complete seeds, advantage {m:+.2f} [95% CI {lo:+.2f}, {hi:+.2f}]")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("live", help="liveness of each candidate dimension; fixes the tuned space")
    common_args(p)
    p.add_argument("--only", default=None, help="DEBUG: comma-separated candidate names to test")
    p.add_argument("--force", action="store_true", help="redo liveness even though tuning has started")
    p.set_defaults(func=cmd_live)

    p = sub.add_parser("run", help="the CEM loop (resumable)")
    common_args(p)
    p.add_argument("--pop", type=int, default=20)
    p.add_argument("--elite", type=int, default=5)
    p.add_argument("--seeds-per-candidate", type=int, default=10)
    p.add_argument("--generations", type=int, required=True)
    p.add_argument("--deadline", default=None, help="HH:MM local; no generation starts after it")
    p.add_argument("--rng-seed", type=int, default=10)
    p.add_argument("--seed-origin", type=int, default=SEED_ORIGIN, help="DEBUG: first generation's seed base")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("validate", help="one-shot validation on seeds 79,800,000-199")
    common_args(p, base_required=False)
    p.add_argument("--start", required=True)
    p.add_argument("--tuned", required=True)
    p.add_argument("--extra", default=None)
    p.add_argument("--seeds", type=int, default=VALIDATE_SEEDS, help="DEBUG override (smoke tests only)")
    p.add_argument("--seed-base", type=int, default=VALIDATE_BASE, help="DEBUG override (smoke tests only)")
    p.add_argument("--force", action="store_true")
    p.add_argument("--report-only", action="store_true", help="print the existing results without playing")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("score", help="advantage [95%% CI] of JSONL files (aggregateMatches.ts statistic)")
    p.add_argument("files", nargs="+")
    p.set_defaults(func=cmd_score)

    args = ap.parse_args()
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    try:
        args.func(args)
    finally:
        kill_running()


if __name__ == "__main__":
    main()
