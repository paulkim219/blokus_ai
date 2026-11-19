#!/usr/bin/env bash
# Hybrid H1 corpus (research_paper/v5_hybrid_preregistered.md, H1 "Data"). Run on the PC from the repo root, in
# tmux, with the binaries pinned in tmp/h1/bin-data (commit in tmp/h1/bin-data/COMMIT). Sizes were chosen from
# the pilot (engine-rs/scripts/h1-pilot.sh, tmp/h1/pilot/log.txt); each block continues the pilot's seeds.
#   order: v5.3-turbo self-play, Pentobi level 7, v5.3-pro self-play (lazy layout), Pentobi level 8.
set -u
OUT=${1:-tmp/h1/data}; mkdir -p $OUT
B=tmp/h1/bin-data
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp
BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
TURBO_GAMES=${TURBO_GAMES:-22000}; L7_GAMES=${L7_GAMES:-6000}; PRO_GAMES=${PRO_GAMES:-2400}; L8_GAMES=${L8_GAMES:-1500}
log() { echo "$(date '+%F %T') $*" | tee -a $OUT/log.txt; }
log "data start, binaries $(cat $B/COMMIT)"

if [ ! -f $OUT/turbo.done ]; then
  $B/blokee-selfplay --config engine-rs/configs/v5.3-turbo.json --games $TURBO_GAMES --budget 300 --threads 16 \
    --seed-base 105100160 --format v3 --out $OUT/turbo 2> $OUT/turbo.stderr && touch $OUT/turbo.done
  log "turbo: $(tail -1 $OUT/turbo.stderr)"
fi
if [ ! -f $OUT/L7.done ]; then
  $B/blokee-pentobi --mode pentobi-self --level 7 --rotations 1 --seeds $L7_GAMES --seed-base 105300032 --threads 16 \
    --pentobi $PENTOBI --book $BOOK --blokee engine-rs/configs/v5.3-turbo.json --label h1-L7 \
    --out $OUT/L7.jsonl --moves-out $OUT/L7.moves.jsonl 2> $OUT/L7.stderr && touch $OUT/L7.done
  log "L7: $(tail -1 $OUT/L7.stderr)"
fi
if [ ! -f $OUT/pro.done ]; then
  $B/blokee-selfplay --config tmp/h1/configs/v5.3-pro-lazy.json --games $PRO_GAMES --budget 300 --threads 16 \
    --seed-base 105200032 --format v3 --out $OUT/pro 2> $OUT/pro.stderr && touch $OUT/pro.done
  log "pro: $(tail -1 $OUT/pro.stderr)"
fi
if [ ! -f $OUT/L8.done ]; then
  $B/blokee-pentobi --mode pentobi-self --level 8 --rotations 1 --seeds $L8_GAMES --seed-base 105400014 --threads 14 \
    --pentobi $PENTOBI --book $BOOK --blokee engine-rs/configs/v5.3-turbo.json --label h1-L8 \
    --out $OUT/L8.jsonl --moves-out $OUT/L8.moves.jsonl 2> $OUT/L8.stderr && touch $OUT/L8.done
  log "L8: $(tail -1 $OUT/L8.stderr)"
fi
log "DATA DONE"
