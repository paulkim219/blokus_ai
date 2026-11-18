"""Read out nested planning budgets, candidate discovery and observable-history controls."""

import math
import random
import statistics

ARMS = ("generic", "generic_repeat", "oracle", "history", "wrong_history")


def validate(rows, seed, homogeneous):
    if [r["hero"] for r in rows] != list(range(4)):
        raise ValueError(f"incomplete rotations for seed {seed}")
    for r in rows:
        pool, base, tail = r["pool"], r["base"], r["proposal_candidates"]
        nominees, planning = r["nominees"], r["planning"]
        if (r["seed"] != seed or pool[:len(base)] != base or len(set(pool)) != len(pool)
                or set(base) & set(tail) or len(tail) != len(set(tail))
                or set(nominees) != set(ARMS) or set(planning) != set(ARMS)
                or any((m not in tail if tail else m is not None) for m in nominees.values())
                or set(pool) != set(base) | (set(nominees.values()) - {None})):
            raise ValueError(f"invalid candidate lists for seed {seed}")
        vectors = [r["evaluation"]]
        for arm in ARMS:
            if len(planning[arm]) != 2:
                raise ValueError(f"missing planning budget for {arm}")
            vectors.extend(planning[arm])
        if any(len(v) != len(pool) or not all(map(math.isfinite, v)) for v in vectors):
            raise ValueError(f"invalid margins for seed {seed}")
        if len(r["posterior"]) != 4 or any(
            len(p) != 3 or any(not 0 <= x <= 1 for x in p) or not math.isclose(sum(p), 1.0)
            for p in r["posterior"]
        ):
            raise ValueError(f"invalid seat posterior for seed {seed}")
        if homogeneous and any(planning[a] != planning["generic"] or nominees[a] != nominees["generic"]
                               for a in ("oracle", "history", "wrong_history")):
            raise ValueError(f"shared-stream identity failed for seed {seed}")


def choices(row, arm, budget):
    pool, base = row["pool"], row["base"]
    scores = row["planning"][arm][budget]

    def pick(extra):
        available = set(base).union(extra)
        indices = [i for i, m in enumerate(pool) if m in available]
        return max(indices, key=scores.__getitem__, default=None)

    # Eligibility, ranking and tie order use no held-out evaluation values.
    return {"base": pick([]), "own": pick([row["nominees"][arm]]), "pool": pick(pool),
            "generic_list": pick([row["nominees"]["generic"]])}


def pairs(row, budget):
    picks = {a: choices(row, a, budget) for a in ARMS}
    values = row["evaluation"]

    def comparison(name, a, b):
        return name, (a != b, 0.0 if a == b else values[a] - values[b])

    results = {}
    for label, arm, control in [
        ("sampling_noise", "generic_repeat", "generic"),
        ("exact_information", "oracle", "generic"),
        ("observable_history", "history", "generic"),
        ("correct_vs_wrong_history", "history", "wrong_history"),
    ]:
        for scope in ("base", "own", "pool"):
            k, v = comparison(f"{label}_{scope}", picks[arm][scope], picks[control][scope])
            results[k] = v
    for arm in ("generic", "oracle", "history"):
        k, v = comparison(f"{arm}_nomination_vs_base", picks[arm]["own"], picks[arm]["base"])
        results[k] = v
        if arm != "generic":
            k, v = comparison(f"{arm}_own_vs_generic_nomination", picks[arm]["own"], picks[arm]["generic_list"])
            results[k] = v
    return results


def aggregate(by_seed):
    rows = [r for block in by_seed for r in block]
    seeds = [statistics.mean(delta for _, delta in block) for block in by_seed]
    gain = statistics.mean(seeds)
    changed = [delta for diff, delta in rows if diff]
    interval = None
    if len(seeds) > 1:
        rng = random.Random(611)
        draws = sorted(sum(rng.choices(seeds, k=len(seeds))) / len(seeds) for _ in range(2000))
        interval = [draws[49], draws[1949]]
    return {"mean_paired_margin_gain": gain, "seed_bootstrap_95": interval,
            "changed_decisions": len(changed), "changed_fraction": len(changed) / len(rows),
            "mean_gain_when_changed": statistics.mean(changed) if changed else None}


def summarize(blocks, low, high):
    rows = [r for block in blocks for r in block]
    summary = {"seed_blocks": len(blocks), "scheduled_decisions": len(rows),
               "decisions_with_outside_candidates": sum(bool(r["proposal_candidates"]) for r in rows),
               "different_nominee_from_generic": {
                   a: sum(r["nominees"][a] != r["nominees"]["generic"] for r in rows) for a in ARMS[1:]},
               "budgets": {}}
    effects = []
    for index, budget in enumerate((low, high)):
        data = [[pairs(r, index) for r in block] for block in blocks]
        by_metric = {key: [[x[key] for x in block] for block in data] for key in data[0][0]}
        effects.append(by_metric["exact_information_base"])
        summary["budgets"][str(budget)] = {key: aggregate(values) for key, values in by_metric.items()}
    nested = [[(False, hi[1] - lo[1]) for lo, hi in zip(a, b)] for a, b in zip(*effects)]
    interaction = aggregate(nested)
    summary["extra_exact_information_gain_high_minus_low_base"] = {
        k: interaction[k] for k in ("mean_paired_margin_gain", "seed_bootstrap_95")}
    return summary
