"""Round 5, Stage 2 (N20) arms: search.iterationShape (existing option; multiplier per own move number,
index = own moves already played) on v5.1-ultra, each normalised to the base's time per game using the
measured in-match ms profile of v5.1-ultra (tmp/v52/shape/shapes.json, round-4 per-seat 800-seed blocks):
sum_k ms_k * m_k = sum_k ms_k over own moves 3-20 (moves 0-2 are the opening heuristic, no search).
Multipliers are capped at CAP. python3 engine-rs/scripts/v52_n20configs.py tmp/v52/S2"""
import copy, json, os, sys

CAP = 6.0
root = sys.argv[1]
sh = json.load(open("tmp/v52/shape/shapes.json"))
ms = {int(k): v for k, v in sh["blokee_ms"].items()}
sims = {int(k): v for k, v in sh["pentobi_sims"].items()}
iters = {int(k): v for k, v in sh["blokee_iterations"].items()}
K = range(3, 21)
total = sum(ms[k] for k in K)
mean_iters = sum(iters[k] for k in range(3, 17)) / 14  # own moves 3-16 (enough positions each)


def normalise(raw, free=None):
    """Scale raw multipliers (capped) so that the time-weighted sum equals the base's. `free`: the set of
    own moves whose multiplier is scaled (the others are kept as given)."""
    free = set(K) if free is None else free
    lo, hi = 1e-3, 1e3
    for _ in range(200):
        c = (lo * hi) ** 0.5
        m = {k: (min(CAP, raw[k] * c) if k in free else raw[k]) for k in K}
        t = sum(ms[k] * m[k] for k in K)
        lo, hi = (c, hi) if t < total else (lo, c)
    return m


def shape(m):
    return [1.0, 1.0, 1.0] + [round(m[k], 4) for k in K]


arms = {}
# (a) middle game (own moves 6-12) x1.5, late (13+) x0.5, early (3-5) absorbs the difference
a = {k: (1.5 if 6 <= k <= 12 else 0.5 if k >= 13 else 1.0) for k in K}
arms["MID"] = ("(a) own moves 6-12 x1.5, 13+ x0.5, 3-5 scaled to equal time", normalise(a, free={3, 4, 5}))
# (d) reverse of (a): 6-12 x1/1.5, 13+ x2, 3-5 scaled
d = {k: (1 / 1.5 if 6 <= k <= 12 else 2.0 if k >= 13 else 1.0) for k in K}
arms["REV"] = ("(d) reverse of (a): own moves 6-12 x0.667, 13+ x2, 3-5 scaled to equal time", normalise(d, free={3, 4, 5}))
# (b) equal time per own move: m_k proportional to 1 / ms_k, capped at CAP
b = {k: 1.0 / ms[k] for k in K}
arms["FLAT"] = (f"(b) equal wall time per own move (m_k proportional to 1/ms_k, capped at x{CAP}), normalised", normalise(b))
# (c) Pentobi's measured shape: iterations proportional to Pentobi's simulations per own move
c = {k: sims[k] / mean_iters for k in K}
arms["PSHAPE"] = (f"(c) iterations proportional to Pentobi level 6's simulations per own move (capped at x{CAP}), normalised", normalise(c))

base = json.load(open("engine-rs/configs/v5.1-ultra.json"))
os.makedirs(os.path.join(root, "configs"), exist_ok=True)
json.dump(base, open(os.path.join(root, "configs", "base.json"), "w"), indent=1)
man = {"base": "engine-rs/configs/v5.1-ultra.json unchanged (iterationScale 14.224)"}
for name, (desc, m) in arms.items():
    cfg = copy.deepcopy(base)
    cfg["search"]["iterationShape"] = shape(m)
    json.dump(cfg, open(os.path.join(root, "configs", f"{name}.json"), "w"), indent=1)
    man[name] = desc + ": " + ", ".join(f"{k}:{m[k]:.2f}" for k in K)
    print(name, man[name])
json.dump(man, open(os.path.join(root, "manifest.json"), "w"), indent=1)
open(os.path.join(root, "ARMS"), "w").write(" ".join(arms) + "\n")
