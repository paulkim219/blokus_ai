#!/usr/bin/env bash
# Round 6 continuation (preregistered 2026-11-15 15:10, "round 6, Stage 4 and order" entry). Waits for the
# running ladder block (tmp/v53/running-block.pid); finishes Stage 3 (resumable, same binary and seeds);
# Stage 4 per tier (nano, lite, base): clean cost of 5 arms (quiet), re-time outside [0.97, 1.03] (check,
# one correction), screen base + arms 400 seeds vs the matched level, best clearing arm confirmed with a fresh
# base on 400 fresh seeds (together) -> engine-rs/configs/v5.3-cand-<tier>.json; then the ladder rung lone L7
# vs three L6 (100 seeds 97,500,000, only if started before 16:45); then the ultra tail (24 seeds 96,700,000,
# 3 threads, only if started before 17:30). Sentinels "R6 S3 DONE", "R6 S4 <tier> DONE", "R6 ULTRA START", "R6 DONE".
set -u
cd "$(dirname "$0")/../.."
R=tmp/v53; BIN=$R/bin; G=engine-rs/configs; BASE=$G/v5.1-ultra.json
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
before() { [ "$(date +%H%M)" -lt "$1" ]; }
bp() {
  local cfg=$1 out=$2 mode=$3 lvl=$4 n=$5 sb=$6 th=$7; shift 7
  echo "=== $(basename $out .jsonl) start $(date '+%F %T')"
  "$BIN/blokee-pentobi" --blokee "$cfg" --pentobi "$PENTOBI" --book "$BOOK" --mode "$mode" --gtp-processes per-seat \
    --level "$lvl" --budget 300 --threads "$th" --seeds "$n" --seed-base "$sb" --label "$(basename $out .jsonl)" \
    --out "$out" --moves-out "${out%.jsonl}.moves.jsonl" "$@" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror" || true
  echo "=== $(basename $out .jsonl) done $(date '+%F %T')"
}
w=$(cat $R/running-block.pid)
echo "R6b waiting for block $w $(date '+%F %T')"
while kill -0 "$w" 2>/dev/null; do sleep 5; done
echo "R6b start $(date '+%F %T')"
i=0
for k in 1 2 3 4 5; do
  for dir in up down; do
    if [ $dir = up ]; then lone=$((k + 1)); three=$k; else lone=$k; three=$((k + 1)); fi
    before 1655 && bp $BASE $R/S3/ladder-L$lone-vs-L$three.jsonl pentobi-ladder $three 200 $((97000000 + 50000 * i)) 10 --lone-level $lone
    i=$((i + 1))
  done
done
before 1655 && bp $G/v5.2-nano.json $R/S3/nano-vs-L2.jsonl one-blokee 2 200 97600000 10
before 1655 && bp $G/v5.2-lite.json $R/S3/lite-vs-L2.jsonl one-blokee 2 200 97700000 10
before 1655 && bp $G/v5.2-lite.json $R/S3/lite-vs-L4.jsonl one-blokee 4 200 97800000 10
before 1655 && bp $G/v5.2.json $R/S3/base-vs-L4.jsonl one-blokee 4 200 97900000 10
before 1655 && bp $G/v5.2.json $R/S3/base-vs-L6.jsonl one-blokee 6 200 97950000 10
python3 engine-rs/scripts/v53_report.py --bench $R > $R/S3/bench.md 2>&1
echo "R6 S3 DONE $(date '+%F %T')"
# ---------------- Stage 4
n=0
for tl in nano:1 lite:3 base:5; do
  tier=${tl%%:*}; lvl=${tl##*:}; D=$R/S4/$tier
  arms=$(cat $D/ARMS)
  BIN=$BIN bash engine-rs/scripts/v51b-cost.sh $D screen $arms
  python3 engine-rs/scripts/v51_report.py --cost $D screen | tee $D/cost/screen-cost.md
  played=""; retimed=""
  for a in $arms; do
    c=$(python3 -c "import json; print(json.load(open('$D/COSTS'))['$a'])")
    if python3 -c "import sys; sys.exit(0 if 0.97 <= float('$c') <= 1.03 else 1)"; then played="$played $a"; else
      python3 engine-rs/scripts/v51b_configs.py retime $D $a "$c" > /dev/null; played="$played $a-ET"; retimed="$retimed $a-ET"; fi
  done
  if [ -n "$retimed" ]; then
    BIN=$BIN bash engine-rs/scripts/v51b-cost.sh $D check1 $retimed
    python3 engine-rs/scripts/v51_report.py --cost $D check1 | tee $D/cost/check1-cost.md
    for a in $retimed; do
      c=$(python3 -c "import json; print(json.load(open('$D/COSTS'))['$a'])")
      python3 -c "import sys; sys.exit(0 if 0.97 <= float('$c') <= 1.03 else 1)" || { python3 engine-rs/scripts/v51b_configs.py correct $D "${a%-ET}" "$c" > /dev/null; echo "corrected $a"; }
    done
  fi
  echo $played > $D/PLAYED
  mkdir -p $D/screen $D/confirm
  for arm in base $played; do
    before 1730 && bp $D/configs/$arm.json $D/screen/rol-$arm.jsonl one-blokee $lvl 400 $((98000000 + 100000 * n)) 10
  done
  { python3 engine-rs/scripts/v51b_report.py --roll-screen $D; echo; python3 engine-rs/scripts/v51c_report.py --roles $(for a in base $played; do echo $D/screen/rol-$a.jsonl; done); } > $D/screen.md 2>&1
  python3 engine-rs/scripts/v51b_report.py --roll-select $D > $D/selected.txt 2> $D/selection.log
  cat $D/screen.md $D/selection.log
  sel=$(tr -d ' \n' < $D/selected.txt)
  if [ -n "$sel" ]; then
    for arm in base $sel; do
      before 1730 && bp $D/configs/$arm.json $D/confirm/rolc-$arm.jsonl one-blokee $lvl 400 $((98300000 + 100000 * n)) 5 &
    done
    wait
    { python3 engine-rs/scripts/v51b_report.py --roll-confirm $D; echo; python3 engine-rs/scripts/v51c_report.py --roles $D/confirm/rolc-base.jsonl $D/confirm/rolc-$sel.jsonl; } > $D/confirm.md 2>&1
    cat $D/confirm.md
    win=$(sed -n 's/^NEW BASE: //p' $D/confirm.md)
    if [ -n "$win" ] && [ "$win" != "(none)" ]; then cp $D/configs/$win.json $G/v5.3-cand-$tier.json; echo "saved $G/v5.3-cand-$tier.json ($win)"; fi
  else
    echo "No $tier arm cleared; no confirmation." | tee $D/confirm.md
  fi
  echo "R6 S4 $tier DONE $(date '+%F %T')"
  n=$((n + 1))
done
# ---------------- ladder rung 6 (one direction)
before 1645 && bp $BASE $R/S3/ladder-L7-vs-L6.jsonl pentobi-ladder 6 100 97500000 10 --lone-level 7
python3 engine-rs/scripts/v53_report.py --bench $R > $R/S3/bench.md 2>&1
# ---------------- ultra tail
if before 1730; then
  echo "R6 ULTRA START $(date '+%F %T')"
  bp $G/v5.2-ultra.json $R/S2/ultra-L9.jsonl one-blokee 9 24 96700000 3
fi
python3 engine-rs/scripts/v53_report.py --tiers $R > $R/S2/tiers.md 2>&1
echo "R6 DONE $(date '+%F %T')"
