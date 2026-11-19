#!/usr/bin/env bash
# Hybrid H1 pilot (research_paper/v5_hybrid_preregistered.md, H1): rates and memory of each data source
# on the PC, before choosing the corpus sizes. Run from the repo root with the pinned binaries in
# tmp/h1/bin-data (built from the commit in tmp/h1/bin-data/COMMIT).
#   engine-rs/scripts/h1-pilot.sh [out-dir]
set -u
OUT=${1:-tmp/h1/pilot}; mkdir -p $OUT
B=tmp/h1/bin-data
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp
BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
log() { echo "$(date '+%F %T') $*" | tee -a $OUT/log.txt; }
memwatch() { while true; do echo "$(date +%s) $(free -m | awk '/Mem:/{print $3}')" >> $OUT/mem-$1.txt; sleep 2; done; }
run() { # name, command...
  local name=$1; shift
  memwatch $name & local w=$!
  local t0=$(date +%s.%N)
  /usr/bin/time -v -o $OUT/time-$name.txt "$@" > $OUT/$name.stdout 2> $OUT/$name.stderr
  local rc=$?
  local t1=$(date +%s.%N)
  kill $w
  local peak=$(sort -k2 -n $OUT/mem-$name.txt | tail -1 | cut -d' ' -f2)
  log "$name: rc $rc, $(echo "$t1 - $t0" | bc) s wall, system used-memory peak ${peak} MiB, max RSS (one process) $(grep 'Maximum resident' $OUT/time-$name.txt | awk '{print $NF}') KiB"
}
log "pilot start, binaries $(cat $B/COMMIT), idle used memory $(free -m | awk '/Mem:/{print $3}') MiB"
run turbo $B/blokee-selfplay --config engine-rs/configs/v5.3-turbo.json --games 160 --budget 300 --threads 16 \
  --seed-base 105100000 --format v3 --out $OUT/turbo
run pro $B/blokee-selfplay --config tmp/h1/configs/v5.3-pro-lazy.json --games 32 --budget 300 --threads 16 \
  --seed-base 105200000 --format v3 --out $OUT/pro
run L7 $B/blokee-pentobi --mode pentobi-self --level 7 --rotations 1 --seeds 32 --seed-base 105300000 --threads 16 \
  --pentobi $PENTOBI --book $BOOK --blokee engine-rs/configs/v5.3-turbo.json --label h1-L7 \
  --out $OUT/L7.jsonl --moves-out $OUT/L7.moves.jsonl
run L8 $B/blokee-pentobi --mode pentobi-self --level 8 --rotations 1 --seeds 14 --seed-base 105400000 --threads 14 \
  --pentobi $PENTOBI --book $BOOK --blokee engine-rs/configs/v5.3-turbo.json --label h1-L8 \
  --out $OUT/L8.jsonl --moves-out $OUT/L8.moves.jsonl
log "pilot done"
