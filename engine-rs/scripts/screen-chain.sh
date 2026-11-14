#!/usr/bin/env bash
# Self-driving screen -> select -> clean cost -> confirm (-> level-7 benchmark) chain against three
# Pentobi level-6 seats, used by N11 (prior re-fit, Stage 3) and S5 (config screen, Stage 4).
# Preregistered 2026-11-13/14 in research_paper/v6_native_and_learning_preregistered.md; results in
# research_paper/v5_speed_and_prior_refit_results.md.
#
#   nohup engine-rs/scripts/screen-chain.sh ROOT > ROOT/chain.log 2>&1 &    # then caffeinate -w <pid>
#
# ROOT must hold (written and committed with the prereg, before the chain starts):
#   PREFIX        label prefix (n11 / s5)
#   ARMS          screen arms (base is played first, then each arm, one after another, 10 threads)
#   SEEDS         "<count> <seed-base>" of the screen;  CSEEDS  the same for the confirmation
#   BSEEDS        optional: "<count> <seed-base>" of a level-7 benchmark of an accepted arm with base
#   configs/      base.json and <arm>.json for every arm
#   manifest.json {arm: change}
# Binary: tmp/s4/bin (the S4 pin). Match settings as P9/P10: budget 300, Pentobi 31.0 with the Classic
# book, one Pentobi thread, 4 games per seed (lone seat rotated). Resumable (blokee-pentobi skips
# seed/seat pairs already present). Sentinel lines: "<PREFIX> SCREEN DONE", "<PREFIX> CHAIN DONE".
set -u
cd "$(dirname "$0")/../.."
ROOT=${1:?root}
BIN=${BIN:-tmp/s4/bin}
THREADS=${THREADS:-10}
PENTOBI=${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}
BOOK=${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}
P=$(cat "$ROOT/PREFIX")
ARMS=$(cat "$ROOT/ARMS")
read -r SN SB < "$ROOT/SEEDS"
read -r CN CB < "$ROOT/CSEEDS"
SUMMARY=$ROOT/summary.txt
load() { uptime | sed 's/.*load averages*: //'; }
mkdir -p "$ROOT/screen" "$ROOT/confirm" "$ROOT/bench" "$ROOT/cost"

play() {  # play <config> <label> <out.jsonl> <seeds> <seed-base> <threads> <level>
  "$BIN/blokee-pentobi" --blokee "$1" --pentobi "$PENTOBI" --book "$BOOK" \
    --mode one-blokee --level "$7" --budget 300 --threads "$6" \
    --seeds "$4" --seed-base "$5" --label "$2" --out "$3" --moves-out "${3%.jsonl}.moves.jsonl"
}

block() {  # block <arm> <dir> <label> <seeds> <seed-base> <threads> <level>
  local arm=$1 dir=$2 label=$3
  echo "=== $label start $(date '+%F %T') load: $(load)"
  play "$ROOT/configs/$arm.json" "$label" "$dir/$label.jsonl" "$4" "$5" "$6" "$7" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|wrote|rror" || true
  echo "=== $label done $(date '+%F %T') load: $(load)"
  {
    echo "=== $label ($(date '+%F %T'), load $(load))"
    [ -f "$dir/$label.failures.jsonl" ] && echo "HARD FAILURES: $(wc -l < "$dir/$label.failures.jsonl")"
    npx tsx scripts/aggregateMatches.ts "$dir/$label.jsonl"
    echo
  } >> "$SUMMARY" 2>&1
}

echo "$P chain start $(date '+%F %T'); base + screen arms: $ARMS; $SN seeds from $SB; binary $BIN"
for arm in base $ARMS; do
  block "$arm" "$ROOT/screen" "${P}s-$arm" "$SN" "$SB" "$THREADS" 6
done
echo "$P SCREEN DONE $(date '+%F %T')"
python3 engine-rs/scripts/chain_report.py "$ROOT" --screen > "$ROOT/screen.md"
cat "$ROOT/screen.md"
python3 engine-rs/scripts/chain_report.py "$ROOT" --select > "$ROOT/selected.txt" 2> "$ROOT/selection.log"
cat "$ROOT/selection.log"
sel=$(head -1 "$ROOT/selected.txt")
if [ -z "$sel" ]; then
  echo "No arm cleared the screen (paired CI lower bound > 0); no confirmation run, as preregistered." | tee "$ROOT/confirm.md"
  echo "NEW BASE: (none)" >> "$ROOT/confirm.md"
  echo "$P CHAIN DONE $(date '+%F %T')"
  exit 0
fi
# Clean cost of the selected arm against base (the screen is over; nothing else of ours runs).
echo "base $sel" > "$ROOT/cost/cost.names"
echo "=== cost start $(date '+%F %T') load: $(load)"
"$BIN/p4_cost" tmp/d1/x1-l6a.moves.jsonl 150 2 "$ROOT/cost/cost.csv" "$ROOT/configs/base.json" "$ROOT/configs/$sel.json" 2>/dev/null
echo "=== cost done $(date '+%F %T') load: $(load)"
ratio=$(python3 engine-rs/scripts/chain_report.py "$ROOT" --cost-ratio "$sel")
echo "$ratio" > "$ROOT/COST_$sel"
echo "clean cost $sel / base = $ratio"
carms="base $sel"
if python3 -c "import sys; sys.exit(0 if float('$ratio') > 1.25 else 1)"; then
  python3 - "$ROOT/configs/$sel.json" "$ROOT/configs/$sel-ET.json" "$ratio" <<'EOF'
import json, sys
c = json.load(open(sys.argv[1]))
c["search"]["iterationScale"] = round(c["search"]["iterationScale"] / float(sys.argv[3]), 3)
json.dump(c, open(sys.argv[2], "w"), indent=1)
EOF
  python3 - "$ROOT/manifest.json" "$sel" "$ratio" <<'EOF'
import json, sys
m = json.load(open(sys.argv[1])); m[sys.argv[2] + "-ET"] = f"{sys.argv[2]} at equal time (iterationScale / {float(sys.argv[3]):.3f})"
json.dump(m, open(sys.argv[1], "w"), indent=1)
EOF
  carms="$carms $sel-ET"
fi
echo "$carms" > "$ROOT/CONFIRM_ARMS"
echo "$P confirmation start $(date '+%F %T'): $carms; $CN seeds from $CB"
n=$(echo $carms | wc -w | tr -d ' ')
per=$(( THREADS / n )); [ "$per" -ge 1 ] || per=1
for arm in $carms; do
  block "$arm" "$ROOT/confirm" "${P}c-$arm" "$CN" "$CB" "$per" 6 &
done
wait
python3 engine-rs/scripts/chain_report.py "$ROOT" --confirm > "$ROOT/confirm.md"
cat "$ROOT/confirm.md"
winner=$(sed -n 's/^NEW BASE: //p' "$ROOT/confirm.md")
if [ -n "$winner" ] && [ "$winner" != "(none)" ] && [ -f "$ROOT/BSEEDS" ]; then
  read -r BN BB < "$ROOT/BSEEDS"
  echo "base $winner" > "$ROOT/BENCH_ARMS"
  echo "$P level-7 benchmark start $(date '+%F %T'): base $winner; $BN seeds from $BB"
  for arm in base $winner; do
    block "$arm" "$ROOT/bench" "${P}b-$arm" "$BN" "$BB" $(( THREADS / 2 )) 7 &
  done
  wait
  python3 engine-rs/scripts/chain_report.py "$ROOT" --bench > "$ROOT/bench.md"
  cat "$ROOT/bench.md"
fi
echo "$P CHAIN DONE $(date '+%F %T')"
