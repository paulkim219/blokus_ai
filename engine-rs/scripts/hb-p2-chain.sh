#!/usr/bin/env bash
# Screen P2 driver (preregistered in research_paper/v5_high_budget_results.md, "Screen P2"; NOT run on
# 2026-11-17/18). Adaptive interior width W1D-AD vs the round-10 control, lone seat vs three Pentobi
# level-7 seats, 300 fresh seeds 103,100,000-103,100,299 in three 100-seed chunks, arm order rotating.
# Setup before running (one-time, by hand, recorded in the results file):
#   D=tmp/hb/p2; mkdir -p $D/configs
#   control: cp <W1D-ET.json if round 10 accepted it, else engine-rs/configs/v5.2-pro.json> $D/configs/base.json
#   candidate: cp tmp/hb/configs/pro-W1D-AD.json $D/configs/W1D-AD.json   (or the -ET re-timed copy)
#   if v5.2-pro is the control, also: cp tmp/v56/pro/configs/W1D-ET.json $D/configs/W1D-ET.json
#   echo "W1D-AD [W1D-ET]" > $D/PLAYED; write $D/manifest.json (arm -> change) and $D/COSTS (arm -> clean cost)
# Resumable: a chunk-arm with a .done marker and 400 result lines is skipped; anything else is replayed.
# usage (repo root of a checkout with the 47647a0+ engine built into BIN): caffeinate -i -s -m engine-rs/scripts/hb-p2-chain.sh
set -u
cd "$(dirname "$0")/../.."
BIN=${BIN:-/Users/paulkim/Blokee/tmp/hb/bin2}; D=${D:-/Users/paulkim/Blokee/tmp/hb/p2}; TH=12
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
mkdir -p $D/chunks $D/screen
ARMS="base $(cat $D/PLAYED)"
play() {  # play <arm> <chunk>
  local arm=$1 k=$2 sb=$((103100000 + 100 * $2)); local out=$D/chunks/rol-$arm-c$k
  if [ -f $out.done ] && [ "$(wc -l < $out.jsonl)" -eq 400 ]; then echo "=== rol-$arm-c$k complete, skipped"; return 0; fi
  rm -f $out.jsonl $out.moves.jsonl $out.timing.jsonl $out.done
  echo "=== rol-$arm-c$k start $(date '+%F %T') (100 seeds from $sb, level 7)"
  "$BIN/blokee-pentobi" --blokee $D/configs/$arm.json --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --gtp-processes per-seat \
    --level 7 --budget 300 --threads "$TH" --seeds 100 --seed-base "$sb" --label "rol-$arm-c$k" \
    --out $out.jsonl --moves-out $out.moves.jsonl 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|rror" || true
  if [ "$(wc -l < $out.jsonl 2>/dev/null || echo 0)" -eq 400 ]; then touch $out.done; echo "=== rol-$arm-c$k done $(date '+%F %T')"
  else echo "=== rol-$arm-c$k INCOMPLETE $(date '+%F %T')"; return 1; fi
}
echo "P2 start $(date '+%F %T'); arms: $ARMS"
set -- $ARMS; n=$#
for k in 0 1 2; do
  # rotate the arm order by chunk
  order=$(echo $ARMS | awk -v k=$k '{for(i=0;i<NF;i++){j=(i+k)%NF+1; printf "%s ", $j}}')
  for arm in $order; do play $arm $k || exit 1; done
  echo "P2 CHUNK $k DONE $(date '+%F %T')"
done
for arm in $ARMS; do
  for x in jsonl moves.jsonl timing.jsonl; do
    : > $D/screen/rol-$arm.$x
    for k in 0 1 2; do cat $D/chunks/rol-$arm-c$k.$x >> $D/screen/rol-$arm.$x; done
  done
done
{ echo "Level 7, 300 seeds from 103100000"; python3 engine-rs/scripts/v51b_report.py --roll-screen $D; } > $D/screen.md 2>&1
echo "P2 DONE $(date '+%F %T')"
