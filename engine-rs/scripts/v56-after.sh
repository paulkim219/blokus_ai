#!/usr/bin/env bash
# Round 9 amendment (prereg 2026-11-16 20:40 entry): after v56-chain.sh ends ("R9 DONE"), W1A (the v5.3 shape) on
# the nano and lite confirmation seeds, paired with each tier's confirmation base arm. Same binary, threads and
# guard as the chain. ROOT tmp/v56/<tier>-w1a links the base arm in; read with v51b_report.py --roll-confirm.
set -u
cd "$(dirname "$0")/../.."
BIN=tmp/v56/bin; TH=12
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
ok() { [ "$(date +%Y%m%d%H%M)" -le 202611170715 ]; }
while ! grep -q "R9 DONE" tmp/v56/chain.log; do sleep 30; done
for spec in "nano 1 101300000" "lite 3 101400000"; do
  set -- $spec; t=$1; lvl=$2; sb=$3; D=tmp/v56/$t; R=tmp/v56/$t-w1a; mkdir -p $R/confirm $R/configs
  cp $D/configs/base.json $D/configs/W1A.json $R/configs/; cp $D/manifest.json $D/COSTS $R/; echo W1A > $R/selected.txt; echo W1A > $R/PLAYED
  for x in jsonl moves.jsonl timing.jsonl; do ln -sf ../../$t/confirm/rolc-base.$x $R/confirm/rolc-base.$x; done
  ok || { echo "=== $t W1A confirmation NOT STARTED (07:15)"; continue; }
  echo "=== $t rolc-W1A start $(date '+%F %T') (800 seeds from $sb, level $lvl)"
  "$BIN/blokee-pentobi" --blokee $R/configs/W1A.json --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --gtp-processes per-seat \
    --level $lvl --budget 300 --threads $TH --seeds 800 --seed-base $sb --label rolc-W1A \
    --out $R/confirm/rolc-W1A.jsonl --moves-out $R/confirm/rolc-W1A.moves.jsonl 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|error" || true
  { echo "Level $lvl, 800 seeds from $sb (W1A, amendment)"; python3 engine-rs/scripts/v51b_report.py --roll-confirm $R 800; } > $R/confirm.md 2>&1
  echo "R9A $t W1A CONFIRM DONE $(date '+%F %T'): $(grep '^NEW BASE' $R/confirm.md)"
done
echo "R9A DONE $(date '+%F %T')"
