#!/usr/bin/env bash
# Round 3, Stage A (preregistered 2026-11-14 17:15, "v5.1 round 3" entry): v5.1-ultra replication.
#   lone seat vs three level-6 seats: v5.0-ultra then v5.1-ultra on 400 seeds 90,000,000, then on 90,100,000
#   blokee-match 400 seeds 90,200,000: one v5.1 vs three v5.0, then one v5.0 vs three v5.1
# Binary: tmp/v51b/bin (round-2 pin, engine 82977fe). Configs copied to tmp/v51c/A. Sentinel "R3A DONE".
set -u
cd "$(dirname "$0")/../.."
A=tmp/v51c/A; BIN=tmp/v51b/bin; THREADS=10
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
before() { [ "$(date +%H%M)" -lt "$1" ]; }
echo "R3A start $(date '+%F %T'); $(sed -n 2p $BIN/PROVENANCE.txt)"
for blk in a1:90000000 a2:90100000; do
  b=${blk%%:*}; s=${blk##*:}
  for c in v5.0-ultra v5.1-ultra; do
    before 2200 || { echo "=== $b-$c NOT STARTED (22:00)"; continue; }
    echo "=== $b-$c start $(date '+%F %T')"
    "$BIN/blokee-pentobi" --blokee $A/$c.json --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --level 6 --budget 300 \
      --threads $THREADS --seeds 400 --seed-base $s --label lone-$c --out $A/$b/lone-$c.jsonl --moves-out $A/$b/lone-$c.moves.jsonl \
      2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror" || true
    echo "=== $b-$c done $(date '+%F %T')"
  done
done
for pair in fwd:v5.1-ultra:v5.0-ultra rev:v5.0-ultra:v5.1-ultra; do
  IFS=: read -r tag ch cp <<< "$pair"
  before 2200 || { echo "=== h2h-$tag NOT STARTED (22:00)"; continue; }
  echo "=== h2h-$tag start $(date '+%F %T')"
  "$BIN/blokee-match" --challenger $A/$ch.json --champion $A/$cp.json --challenger-name $ch --champion-name $cp \
    --seeds 400 --seed-base 90200000 --budget 300 --threads $THREADS --label h2h-$tag --out $A/h2h-$tag.jsonl 2>&1 | tail -1
  echo "=== h2h-$tag done $(date '+%F %T')"
done
python3 engine-rs/scripts/v51c_report.py --stageA $A > $A/stageA.md 2>&1
cat $A/stageA.md
echo "R3A DONE $(date '+%F %T')"
