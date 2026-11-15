#!/usr/bin/env bash
# Round 4, Stage 2 continued (driver v51d-stage2.sh stopped by hand at 21:34 after its rol-R-EX block
# started; preregistered addition 2026-11-14 21:45, "round 4, paired seeding block").
# Round 4, Stage 2 (N19) then the deferred Stage-1 level-7 block, then Stage 3 (preregistered 2026-11-14,
# "round 4, Stage 2" entry). Waits for the Stage-1 driver. Per-seat Pentobi processes throughout.
#   clean cost of R-EX, R-CH, A-EX vs base v5.1-ultra (quiet); arms outside [0.97, 1.03] re-timed (check, one correction)
#   screen base + arms, 400 seeds 91,600,000; role tables and c_moves numbers; select by the standing rule
#   confirm the best clearing arm with a fresh base, 400 seeds 91,700,000 (started together) -> v5.2-cand-ultra.json
#   v5.1-ultra vs three level-7 seats, 200 seeds 91,300,000 (only if started before 23:20)
#   Stage 3: v5.1-ultra at x1, x2, x0.5 iterations, 200 seeds 91,800,000 (each block only before 00:30)
# Binary tmp/v51d/bin2 (engine 6616c10). Sentinel "R4S2 DONE"; the paired seeding block (bin3) runs after the screen, before the confirmation.
set -u
cd "$(dirname "$0")/../.."
R=tmp/v51d/S2; BIN=tmp/v51d/bin2; THREADS=10
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
before() { h=$(date +%H%M); [ "$h" -ge 1200 ] && [ "$h" -lt "$1" ]; }
ok() { h=$(date +%H%M); [ "$h" -lt 0030 ] || [ "$h" -ge 1200 ]; }
play() {  # play <config> <out> <seeds> <base> <level> <threads>
  ok || { echo "=== $(basename $2 .jsonl) NOT STARTED (00:30)"; return; }
  echo "=== $(basename $2 .jsonl) start $(date '+%F %T')"
  "$BIN/blokee-pentobi" --blokee "$1" --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --gtp-processes per-seat \
    --level "$5" --budget 300 --threads "$6" --seeds "$3" --seed-base "$4" --label "$(basename $2 .jsonl)" \
    --out "$2" --moves-out "${2%.jsonl}.moves.jsonl" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror" || true
  echo "=== $(basename $2 .jsonl) done $(date '+%F %T')"
}
wpid=21666
echo "R4S2b waiting for rol-R-EX ($wpid) $(date '+%F %T')"
while kill -0 "$wpid" 2>/dev/null; do sleep 20; done
echo "R4S2b start $(date '+%F %T')"
mkdir -p $R/screen $R/confirm
played=$(cat $R/PLAYED)
for arm in base $played; do
  play $R/configs/$arm.json $R/screen/rol-$arm.jsonl 400 91600000 6 $THREADS
done
{
  python3 engine-rs/scripts/v51b_report.py --roll-screen $R
  echo; python3 engine-rs/scripts/v51c_report.py --roles $(for a in base $played; do echo $R/screen/rol-$a.jsonl; done)
  echo; python3 engine-rs/scripts/v51d_report.py --cmoves $R base $played
} > $R/screen.md 2>&1
cat $R/screen.md
python3 engine-rs/scripts/v51b_report.py --roll-select $R > $R/selected.txt 2> $R/selection.log
cat $R/selection.log
sel=$(tr -d ' \n' < $R/selected.txt)

# ---------------- paired seeding block: v5.1-ultra, 400 seeds 92,000,000, shared / per-seat / per-seat identical seeds
Q=tmp/v51d/SEED; mkdir -p $Q
for mode in shared:shared: perseat:per-seat: game:per-seat:--per-seat-seed_game; do
  IFS=: read -r tag procs extra <<< "$mode"
  extra=${extra//_/ }
  ok || { echo "=== seed-$tag NOT STARTED (00:30)"; continue; }
  echo "=== seed-$tag start $(date '+%F %T')"
  tmp/v51d/bin3/blokee-pentobi --blokee engine-rs/configs/v5.1-ultra.json --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee \
    --gtp-processes $procs $extra --level 6 --budget 300 --threads $THREADS --seeds 400 --seed-base 92000000 --label seed-$tag \
    --out $Q/seed-$tag.jsonl --moves-out $Q/seed-$tag.moves.jsonl 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror" || true
  echo "=== seed-$tag done $(date '+%F %T')"
done
python3 engine-rs/scripts/v51d_report.py --seed $Q > $Q/seed.md 2>&1
cat $Q/seed.md
echo "R4 SEED BLOCK DONE $(date '+%F %T')"
if [ -n "$sel" ]; then
  for arm in base $sel; do
    play $R/configs/$arm.json $R/confirm/rolc-$arm.jsonl 400 91700000 6 5 &
  done
  wait
  {
    python3 engine-rs/scripts/v51b_report.py --roll-confirm $R
    echo; python3 engine-rs/scripts/v51c_report.py --roles $R/confirm/rolc-base.jsonl $R/confirm/rolc-$sel.jsonl
  } > $R/confirm.md 2>&1
  cat $R/confirm.md
  w=$(sed -n 's/^NEW BASE: //p' $R/confirm.md)
  if [ -n "$w" ] && [ "$w" != "(none)" ]; then
    cp $R/configs/$w.json engine-rs/configs/v5.2-cand-ultra.json; echo "saved engine-rs/configs/v5.2-cand-ultra.json ($w)"
  fi
else
  echo "No Stage-2 arm cleared; no confirmation, as preregistered." | tee $R/confirm.md
fi
echo "R4S2 STAGE2 DONE $(date '+%F %T')"
if before 2330; then
  play engine-rs/configs/v5.1-ultra.json tmp/v51d/S1/v51-l7.jsonl 200 91300000 7 $THREADS
else
  echo "past 23:30: level-7 block not started"
fi
S3=tmp/v51d/S3; mkdir -p $S3/configs
python3 - <<'PY'
import json
c = json.load(open("engine-rs/configs/v5.1-ultra.json"))
for name, f in (("D-base", 1.0), ("D-x2", 2.0), ("D-x05", 0.5)):
    d = json.loads(json.dumps(c)); d["search"]["iterationScale"] = round(14.224 * f, 3)
    json.dump(d, open(f"tmp/v51d/S3/configs/{name}.json", "w"), indent=1)
PY
for arm in D-base D-x2 D-x05; do
  play $S3/configs/$arm.json $S3/v51d-$arm.jsonl 200 91800000 6 $THREADS
done
python3 engine-rs/scripts/v51d_report.py --stage1 tmp/v51d/S1 > tmp/v51d/S1/stage1.md 2>&1
for arm in D-x2 D-x05; do
  [ -f $S3/v51d-$arm.jsonl ] && [ -f $S3/v51d-D-base.jsonl ] && python3 -c "
import sys; sys.path.insert(0, 'engine-rs/scripts')
from v51c_report import paired, fmt_ci, arm_line
n, d, f1, f2 = paired('$S3/v51d-$arm.jsonl', '$S3/v51d-D-base.jsonl')
print('$arm vs D-base:', fmt_ci(d), 'on', n, 'seeds; first place (split)', fmt_ci(f2), 'pp')"
done > $S3/stage3.md 2>&1
cat $S3/stage3.md
echo "R4S2 DONE $(date '+%F %T')"
