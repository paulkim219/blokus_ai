#!/usr/bin/env bash
# Round 11 ultra screen at L8 (amendment 3 in research_paper/v5_high_budget_results.md): U32-8 vs U (v5.2-ultra),
# lone seat vs three Pentobi L8 seats, fresh seeds from 104,200,000 in 6-seed chunks played in order
# (chunk k = 104,200,000 + 6k), both arms of a chunk side by side (one game thread each).
# Same driver as v58-screen.sh (kept unchanged because it was running when this was written), with the seed base,
# output directory and a fixed last chunk as parameters. Stops by itself after chunk $LASTK (default 33 -> 204 seeds).
# Stop early at a chunk boundary: touch $D/STOP. Resumable: a chunk-arm with .done and 24 result lines is skipped.
# Results are NOT read here; read only at the preregistered N with SB=104200000 D=... v58-screen-read.sh 204.
# usage (repo root, through bash): bash engine-rs/scripts/v58-screen-l8.sh
set -u
cd "$(dirname "$0")/../.."
BIN=${BIN:-/Users/paulkim/Blokee/tmp/hb/bin2}; D=${D:-/Users/paulkim/Blokee/tmp/v58/screen-l8}
LEVEL=${LEVEL:-8}; SB=${SB:-104200000}; LASTK=${LASTK:-33}
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
mkdir -p $D/chunks
[ -d $D/configs ] || { mkdir -p $D/configs; cp /Users/paulkim/Blokee/tmp/v58/screen/configs/*.json $D/configs/; }
( while true; do
    echo "$(date '+%F %T') $(vm_stat | awk '/Pages free/{f=$3}/Anonymous/{a=$3}/wired down/{w=$4}END{printf "free %.1f GB anon %.1f GB wired %.1f GB", f*16384/1e9, a*16384/1e9, w*16384/1e9}') $(sysctl -n vm.swapusage | awk '{print "swap_used", $6}') load $(sysctl -n vm.loadavg | awk '{print $2}') $(pmset -g batt | grep -o "'.*'")"
    sleep 300
  done ) >> $D/mem.log 2>&1 &
MEMPID=$!
trap "kill $MEMPID 2>/dev/null" EXIT
play() {  # play <arm> <chunk>
  local arm=$1 k=$2 sb=$(($SB + 6 * $2)); local out=$D/chunks/scr-$arm-c$k
  if [ -f $out.done ] && [ "$(wc -l < $out.jsonl)" -eq 24 ]; then return 0; fi
  rm -f $out.jsonl $out.moves.jsonl $out.timing.jsonl $out.done
  echo "=== scr-$arm-c$k start $(date '+%F %T') (6 seeds from $sb, level $LEVEL)"
  "$BIN/blokee-pentobi" --blokee $D/configs/$arm.json --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --gtp-processes per-seat \
    --level $LEVEL --budget 300 --threads 1 --seeds 6 --seed-base "$sb" --label "scr-$arm-c$k" \
    --out $out.jsonl --moves-out $out.moves.jsonl 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|rror" || true
  if [ "$(wc -l < $out.jsonl 2>/dev/null || echo 0)" -eq 24 ]; then touch $out.done; echo "=== scr-$arm-c$k done $(date '+%F %T')"
  else echo "=== scr-$arm-c$k INCOMPLETE $(date '+%F %T')"; return 1; fi
}
swapmb() { sysctl -n vm.swapusage | awk '{v=$6; sub("M","",v); print int(v)}'; }
SWAP0=$(swapmb)
echo "screen start $(date '+%F %T'); level $LEVEL; seeds from $SB; chunks 0..$LASTK; arms U U32-8; swap used at start ${SWAP0}M"
SEQ=0
for k in $(seq 0 $LASTK); do
  [ -f $D/STOP ] && { echo "STOP file seen before chunk $k $(date '+%F %T')"; break; }
  if [ $SEQ -eq 0 ] && [ $(( $(swapmb) - SWAP0 )) -gt 1024 ]; then SEQ=1; echo "MEMORY GUARD: swap $(swapmb)M > start+1024M; arms play one after the other from chunk $k $(date '+%F %T')"; fi
  if [ $SEQ -eq 1 ]; then play U $k; ra=$?; play U32-8 $k; rb=$?
  else play U $k & a=$!; play U32-8 $k & b=$!; wait $a; ra=$?; wait $b; rb=$?; fi
  [ $ra -eq 0 ] && [ $rb -eq 0 ] || { echo "chunk $k failed; chain stops $(date '+%F %T')"; exit 1; }
  echo "SCREEN CHUNK $k DONE $(date '+%F %T') (seeds through $(($SB + 6 * k + 5)))"
done
echo "SCREEN CHAIN END $(date '+%F %T')"
