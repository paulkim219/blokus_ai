#!/usr/bin/env bash
# v5.1 candidate chain, self-driving (preregistered 2026-11-14, "v5.1 candidates" entry in
# research_paper/v6_native_and_learning_preregistered.md; read-out engine-rs/scripts/v51_report.py):
#   1. screen: base (v5.0-ultra) then every arm in ROOT/ARMS, 400 seeds 89,000,000-89,000,399, 10 threads
#   2. compute diagnostics: D-base, D-x2, D-x05, 200 seeds 89,100,000-89,100,199, 10 threads
#   3. selection by the preregistered rule (v51_report.py --select); clean cost of COMBO if built
#      (quiet machine: nothing else of ours runs between the screen and the confirmation)
#   4. confirmation: base + selected arms, 400 seeds 89,200,000-89,200,399, started together
#      (not started at or after 13:45 CST); an accepted winner is saved as engine-rs/configs/v5.1-ultra.json
#   5. Stage 3 (only with v5.1 saved; each block only if started before 13:30 CST): v5.1 vs three
#      v5.0-ultra seats (blokee-match, 200 seeds 89,400,000), then v5.1 vs three level-7 seats (200 seeds 89,300,000)
#
#   nohup engine-rs/scripts/v51-chain.sh > tmp/v51/chain.log 2>&1 &     # then caffeinate -i -s -m -w <pid>
#
# Binary: tmp/v51/bin (pinned, PROVENANCE.txt). Match settings as last night: budget 300, Pentobi 31.0,
# Classic book, one Pentobi thread, 4 games per seed (lone seat rotated). Resumable (blokee-pentobi skips
# finished seed/seat pairs). Sentinels: "V51 SCREEN DONE", "V51 CONFIRM DONE", "V51 STAGE3 DONE", "V51 CHAIN DONE".
set -u
cd "$(dirname "$0")/../.."
ROOT=tmp/v51
BIN=$ROOT/bin
THREADS=${THREADS:-10}
PENTOBI=${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}
BOOK=${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}
SUMMARY=$ROOT/summary.txt
load() { uptime | sed 's/.*load averages*: //'; }
before() { [ "$(date +%H%M)" -lt "$1" ]; }
mkdir -p $ROOT/screen $ROOT/diag $ROOT/confirm $ROOT/stage3

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

echo "V51 chain start $(date '+%F %T'); binary $BIN ($(sed -n 2p $BIN/PROVENANCE.txt))"
for arm in base $(cat $ROOT/ARMS); do
  block "$arm" $ROOT/screen "v51s-$arm" 400 89000000 "$THREADS" 6
done
for arm in $(cat $ROOT/DARMS); do
  block "$arm" $ROOT/diag "v51d-$arm" 200 89100000 "$THREADS" 6
done
echo "V51 SCREEN DONE $(date '+%F %T')"
python3 engine-rs/scripts/v51_report.py --screen $ROOT > $ROOT/screen.md 2>&1
cat $ROOT/screen.md
python3 engine-rs/scripts/v51_report.py --select $ROOT > $ROOT/selected.txt 2> $ROOT/selection.log
cat $ROOT/selection.log
if [ -z "$(tr -d ' \n' < $ROOT/selected.txt)" ]; then
  echo "No arm competes for confirmation; no confirmation run, as preregistered." | tee $ROOT/confirm.md
  echo "NEW BASE: (none)" >> $ROOT/confirm.md
  echo "V51 CONFIRM DONE $(date '+%F %T'); v5.1: none"
  echo "V51 CHAIN DONE $(date '+%F %T')"
  exit 0
fi
if grep -q COMBO $ROOT/selected.txt; then
  bash engine-rs/scripts/v51-cost.sh $ROOT combo COMBO
  python3 engine-rs/scripts/v51_report.py --cost $ROOT combo | tee $ROOT/cost/combo-cost.md
fi
python3 engine-rs/scripts/v51_report.py --finalize $ROOT 2>&1
carms=$(cat $ROOT/CONFIRM_ARMS)
n=$(echo $carms | wc -w | tr -d ' ')
per=$(( (THREADS + n - 1) / n ))
winner=""
if before 1345; then
  echo "V51 confirmation start $(date '+%F %T'): $carms; 400 seeds from 89,200,000; $per threads each"
  for arm in $carms; do
    block "$arm" $ROOT/confirm "v51c-$arm" 400 89200000 "$per" 6 &
  done
  wait
  python3 engine-rs/scripts/v51_report.py --confirm $ROOT > $ROOT/confirm.md 2>&1
  cat $ROOT/confirm.md
  winner=$(sed -n 's/^NEW BASE: //p' $ROOT/confirm.md)
else
  echo "past 13:45: confirmation not started, as preregistered" | tee $ROOT/confirm.md
fi
saved=""
if [ -n "$winner" ] && [ "$winner" != "(none)" ]; then
  cp "$ROOT/configs/$winner.json" engine-rs/configs/v5.1-ultra.json
  saved=engine-rs/configs/v5.1-ultra.json
fi
echo "V51 CONFIRM DONE $(date '+%F %T'); v5.1: ${saved:-none} (${winner:-none})"
if [ -n "$saved" ]; then
  if before 1330; then
    echo "=== v51-h2h start $(date '+%F %T') load: $(load)"
    "$BIN/blokee-match" --challenger "$saved" --champion engine-rs/configs/v5.0-ultra.json --challenger-name v5.1-ultra \
      --champion-name v5.0-ultra --seeds 200 --seed-base 89400000 --budget 300 --threads "$THREADS" \
      --label v51-h2h --out $ROOT/stage3/v51-h2h.jsonl 2>&1 | tail -1
    echo "=== v51-h2h done $(date '+%F %T') load: $(load)"
  else
    echo "past 13:30: head-to-head not started"
  fi
  if before 1330; then
    cp "$saved" $ROOT/configs/v5.1-ultra.json
    block v5.1-ultra $ROOT/stage3 v51-l7 200 89300000 "$THREADS" 7
  else
    echo "past 13:30: level-7 benchmark not started"
  fi
  python3 engine-rs/scripts/v51_report.py --stage3 $ROOT 2>&1 | tee $ROOT/stage3.md
fi
echo "V51 STAGE3 DONE $(date '+%F %T')"
echo "V51 CHAIN DONE $(date '+%F %T')"
