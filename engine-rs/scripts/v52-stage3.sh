#!/usr/bin/env bash
# Round 5, Stage 3 (preregistered 2026-11-15 00:30, "round 5, Stage 3" entry). Waits for the Stage-2 driver.
# Base: engine-rs/configs/v5.2-cand-ultra.json if Stage 2 saved it, else v5.1-ultra.
# If at least 90 minutes remain before 07:00: CEM tuner (v52_tune.py, shared process, training seeds from
# 94,000,000) until 07:00; final point -> clean cost vs base (quiet); outside [0.97, 1.03] -> equal time;
# validation vs the base, per-seat, 400 seeds 95,000,000 then 400 seeds 95,100,000 (base, candidate per block);
# accepted (paired lower bound > 0 over the 800, first-place interval not entirely below 0) ->
# engine-rs/configs/v5.2-cand-ultra.json (v5.3-cand-ultra.json if Stage 2 saved a v5.2 candidate).
# Otherwise: replicate the Stage-2 screen arm with the largest point estimate vs base on 800 seeds
# 95,200,000 + 95,300,000 (descriptive). No block at or after 08:15. Sentinel "R5S3 DONE".
set -u
cd "$(dirname "$0")/../.."
R=tmp/v52/S3; BIN=tmp/v51d/bin3; THREADS=10
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
ok() { h=$(date +%H%M); [ "$h" -lt 0815 ] || [ "$h" -ge 1200 ]; }
play() {  # play <config> <out> <seeds> <base> <threads>
  ok || { echo "=== $(basename $2 .jsonl) NOT STARTED (08:15)"; return; }
  echo "=== $(basename $2 .jsonl) start $(date '+%F %T')"
  "$BIN/blokee-pentobi" --blokee "$1" --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --gtp-processes per-seat \
    --level 6 --budget 300 --threads "$5" --seeds "$3" --seed-base "$4" --label "$(basename $2 .jsonl)" \
    --out "$2" --moves-out "${2%.jsonl}.moves.jsonl" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror" || true
  echo "=== $(basename $2 .jsonl) done $(date '+%F %T')"
}
w=$(cat tmp/v52/S2/chain.pid)
echo "R5S3 waiting for Stage 2 ($w) $(date '+%F %T')"
while kill -0 "$w" 2>/dev/null; do sleep 20; done
mkdir -p $R/configs $R/val
base=engine-rs/configs/v5.1-ultra.json; save=engine-rs/configs/v5.2-cand-ultra.json
if [ -f engine-rs/configs/v5.2-cand-ultra.json ]; then base=engine-rs/configs/v5.2-cand-ultra.json; save=engine-rs/configs/v5.3-cand-ultra.json; fi
cp $base $R/configs/base.json
echo "R5S3 start $(date '+%F %T'); base $base"
mins=$(python3 -c "
import datetime as d; t=d.datetime.now(); dl=t.replace(hour=7,minute=0,second=0,microsecond=0)
dl = dl if dl > t - d.timedelta(hours=12) else dl + d.timedelta(days=1); print(int((dl-t).total_seconds()//60))")
echo "minutes until 07:00: $mins"
if [ "$mins" -ge 90 ]; then
  python3 engine-rs/scripts/v52_tune.py run --base $R/configs/base.json --out $R/tune --bin $BIN/blokee-pentobi --deadline 07:00 > $R/tune.log 2>&1
  tail -5 $R/tune.log
  cp $R/tune/final.json $R/configs/TUNED.json
  cat $R/tune/final-point.json
  echo "TUNED fixed $(date '+%F %T')"
  echo "base TUNED" > $R/cost/names 2>/dev/null || mkdir -p $R/cost
  BIN=tmp/v51d/bin2 bash engine-rs/scripts/v51b-cost.sh $R screen TUNED
  python3 engine-rs/scripts/v51_report.py --cost $R screen | tee $R/cost/screen-cost.md
  c=$(python3 -c "import json; print(json.load(open('$R/COSTS'))['TUNED'])")
  cand=TUNED
  if ! python3 -c "import sys; sys.exit(0 if 0.97 <= float('$c') <= 1.03 else 1)"; then
    python3 - "$c" <<'PY'
import json, sys
c = float(sys.argv[1]); p = "tmp/v52/S3/configs/TUNED.json"; cfg = json.load(open(p))
cfg["search"]["iterationScale"] = round(cfg["search"]["iterationScale"] / c, 3)
json.dump(cfg, open("tmp/v52/S3/configs/TUNED-ET.json", "w"), indent=1)
print("TUNED-ET iterationScale", cfg["search"]["iterationScale"])
PY
    cand=TUNED-ET
  fi
  echo "$cand" > $R/CANDIDATE
  for blk in v1:95000000 v2:95100000; do
    b=${blk%%:*}; s=${blk##*:}
    for arm in base $cand; do
      play $R/configs/$arm.json $R/val/$b-$arm.jsonl 400 $s $THREADS
    done
  done
  python3 - "$cand" "$save" <<'PY' > $R/validation.md 2>&1
import os, sys, shutil
sys.path.insert(0, "engine-rs/scripts")
from v51c_report import paired, merged, fmt_ci, arm_line, roles
cand, save = sys.argv[1], sys.argv[2]
R = "tmp/v52/S3/val"
for arm in ("base", cand):
    parts = [f"{R}/{b}-{arm}.jsonl" for b in ("v1", "v2") if os.path.exists(f"{R}/{b}-{arm}.jsonl")]
    merged(parts, f"{R}/all-{arm}.jsonl")
print("| Arm | Seeds | Advantage | First place (any) | First place (split) |\n|---|---:|---:|---:|---:|")
for arm in ("base", cand):
    print(arm_line(arm, f"{R}/all-{arm}.jsonl"))
n, d, f1, f2 = paired(f"{R}/all-{cand}.jsonl", f"{R}/all-base.jsonl")
for b in ("v1", "v2"):
    if os.path.exists(f"{R}/{b}-{cand}.jsonl") and os.path.exists(f"{R}/{b}-base.jsonl"):
        nb, db, _, fb = paired(f"{R}/{b}-{cand}.jsonl", f"{R}/{b}-base.jsonl")
        print(f"- block {b}: {fmt_ci(db)} on {nb} seeds; first place (split) {fmt_ci(fb)} pp")
ok = n >= 800 and d[1] > 0 and not (f2[2] < 0)
print(f"\n- {cand} − base, {n} seeds: {fmt_ci(d)}; first place (any) {fmt_ci(f1)} pp, (split) {fmt_ci(f2)} pp -> {'ACCEPTED' if ok else 'NOT ACCEPTED'}")
print()
roles([f"{R}/all-base.jsonl", f"{R}/all-{cand}.jsonl"])
if ok:
    shutil.copy(f"tmp/v52/S3/configs/{cand}.json", save)
    print(f"\nsaved {save}")
PY
  cat $R/validation.md
else
  arm=$(python3 - <<'PY'
import sys; sys.path.insert(0, "engine-rs/scripts")
from v51c_report import paired
best = None
for a in open("tmp/v52/S2/PLAYED").read().split():
    n, d, _, _ = paired(f"tmp/v52/S2/screen/rol-{a}.jsonl", "tmp/v52/S2/screen/rol-base.jsonl")
    if best is None or d[0] > best[0]:
        best = (d[0], a)
print(best[1])
PY
)
  echo "fewer than 90 minutes for tuning: replicating Stage-2 arm $arm on 95,200,000 + 95,300,000"
  cp tmp/v52/S2/configs/$arm.json $R/configs/REP.json
  for blk in r1:95200000 r2:95300000; do
    b=${blk%%:*}; s=${blk##*:}
    for a in base REP; do
      play $R/configs/$a.json $R/val/$b-$a.jsonl 400 $s $THREADS
    done
  done
fi
echo "R5S3 DONE $(date '+%F %T')"
