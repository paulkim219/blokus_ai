#!/usr/bin/env bash
# Round 11 Step D pilot (prereg in research_paper/v5_high_budget_results.md, "Round 11"): lone seat vs three
# Pentobi level-8 seats, 12 seeds 104,000,000-104,000,011 in two 6-seed chunks, chunk 0 = U then the cap
# arm, chunk 1 reversed. Per-arm concurrency from $D/THREADS ("<arm> <n>" lines). Resumable: a chunk-arm
# with .done and 24 result lines is skipped; anything else is replayed. Memory logged every 60 s.
# Setup: $D/configs/{U,<arm>}.json, $D/PLAYED (= <arm>), $D/THREADS, $D/manifest.json, $D/COSTS.
# usage (from the repo root, through bash): bash engine-rs/scripts/v58-pilot.sh
set -u
cd "$(dirname "$0")/../.."
BIN=${BIN:-/Users/paulkim/Blokee/tmp/hb/bin2}; D=${D:-/Users/paulkim/Blokee/tmp/v58/pilot}
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
mkdir -p $D/chunks $D/screen
ARM=$(cat $D/PLAYED)
( while true; do
    echo "$(date '+%F %T') $(vm_stat | awk '/Pages free/{f=$3}/Anonymous/{a=$3}/occupied by compressor/{c=$3}/wired down/{w=$4}END{printf "free %.1f GB anon %.1f GB compressor %.1f GB wired %.1f GB", f*16384/1e9, a*16384/1e9, c*16384/1e9, w*16384/1e9}') $(sysctl -n vm.swapusage | awk '{print "swap_used", $6}') load $(sysctl -n vm.loadavg | awk '{print $2}')"
    sleep 60
  done ) >> $D/mem.log 2>&1 &
MEMPID=$!
trap "kill $MEMPID 2>/dev/null" EXIT
play() {  # play <arm> <chunk>
  local arm=$1 k=$2 sb=$((104000000 + 6 * $2)); local out=$D/chunks/pil-$arm-c$k
  local th=$(awk -v a=$arm '$1==a{print $2}' $D/THREADS)
  if [ -f $out.done ] && [ "$(wc -l < $out.jsonl)" -eq 24 ]; then echo "=== pil-$arm-c$k complete, skipped"; return 0; fi
  rm -f $out.jsonl $out.moves.jsonl $out.timing.jsonl $out.done
  echo "=== pil-$arm-c$k start $(date '+%F %T') (6 seeds from $sb, level 8, $th threads)"
  "$BIN/blokee-pentobi" --blokee $D/configs/$arm.json --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --gtp-processes per-seat \
    --level 8 --budget 300 --threads "$th" --seeds 6 --seed-base "$sb" --label "pil-$arm-c$k" \
    --out $out.jsonl --moves-out $out.moves.jsonl 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|rror" || true
  if [ "$(wc -l < $out.jsonl 2>/dev/null || echo 0)" -eq 24 ]; then touch $out.done; echo "=== pil-$arm-c$k done $(date '+%F %T')"
  else echo "=== pil-$arm-c$k INCOMPLETE $(date '+%F %T')"; return 1; fi
}
echo "pilot start $(date '+%F %T'); arms: U $ARM"
play U 0 || exit 1; play $ARM 0 || exit 1; echo "PILOT CHUNK 0 DONE $(date '+%F %T')"
play $ARM 1 || exit 1; play U 1 || exit 1; echo "PILOT CHUNK 1 DONE $(date '+%F %T')"
for arm in U $ARM; do
  for x in jsonl moves.jsonl timing.jsonl; do
    : > $D/screen/rol-$arm.$x
    for k in 0 1; do cat $D/chunks/pil-$arm-c$k.$x >> $D/screen/rol-$arm.$x; done
  done
done
cp $D/configs/U.json $D/configs/base.json 2>/dev/null; for x in jsonl moves.jsonl timing.jsonl; do cp $D/screen/rol-U.$x $D/screen/rol-base.$x; done
{ echo "Level 8, 12 seeds from 104000000 (pilot, descriptive)"; python3 engine-rs/scripts/v51b_report.py --roll-screen $D; } > $D/screen.md 2>&1
echo "PILOT DONE $(date '+%F %T')"
