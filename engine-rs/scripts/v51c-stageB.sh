#!/usr/bin/env bash
# Round 3, Stage B (preregistered 2026-11-14, "v5.1 round 3, Stage B" entry): process-artefact controls.
# Waits for the Stage-A driver (pid in tmp/v51c/A/chain.pid) to exit, then:
#   B1  lone v5.0-ultra vs three level-6 seats, 200 seeds 90,300,000: shared process (today), then per-seat processes
#   B2  pentobi-control: lone level-6 seat in its own process vs three level-6 seats in one shared process, 200 seeds 90,400,000
# Binary tmp/v51c/bin (engine dfc727e). Sentinel "R3B DONE".
set -u
cd "$(dirname "$0")/../.."
B=tmp/v51c/B; BIN=tmp/v51c/bin; THREADS=10
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
before() { [ "$(date +%H%M)" -lt "$1" ]; }
mkdir -p $B
apid=$(cat tmp/v51c/A/chain.pid)
echo "R3B waiting for Stage A ($apid) $(date '+%F %T')"
while kill -0 "$apid" 2>/dev/null; do sleep 20; done
echo "R3B start $(date '+%F %T'); $(sed -n 2p $BIN/PROVENANCE.txt)"
run() {  # run <tag> <seeds-base> <mode> <processes>
  before 2200 || { echo "=== $1 NOT STARTED (22:00)"; return; }
  echo "=== $1 start $(date '+%F %T')"
  "$BIN/blokee-pentobi" --blokee engine-rs/configs/v5.0-ultra.json --pentobi "$PENTOBI" --book "$BOOK" --mode "$3" \
    --gtp-processes "$4" --level 6 --budget 300 --threads $THREADS --seeds 200 --seed-base "$2" --label "$1" \
    --out $B/$1.jsonl --moves-out $B/$1.moves.jsonl 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror" || true
  echo "=== $1 done $(date '+%F %T')"
}
run b1-shared 90300000 one-blokee shared
run b1-perseat 90300000 one-blokee per-seat
run b2-control 90400000 pentobi-control shared
python3 engine-rs/scripts/v51c_report.py --stageB $B > $B/stageB.md 2>&1
cat $B/stageB.md
echo "R3B DONE $(date '+%F %T')"
