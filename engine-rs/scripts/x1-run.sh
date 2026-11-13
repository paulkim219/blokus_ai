#!/usr/bin/env bash
# X1 queue (Pentobi benchmark, level-6 design): X1-L6a, X1-L6b, then the level-5 and level-7
# ladder, in that order, each scored with scripts/aggregateMatches.ts into $OUT/summary.txt. Seeds
# and sizes are the 2026-11-12 addenda of research_paper/v6_native_and_learning_preregistered.md
# ("X1 moved from Pentobi level 9 to level 6"). Run the validity gate first (docs/E6_RUNBOOK.md,
# "Pentobi benchmark"); it must print VALIDITY GATE PASSED.
#
#   nohup engine-rs/scripts/x1-run.sh > tmp/x1/queue.log 2>&1 &
#
# Resumable: rerunning skips every seed/seat pair already in a run's JSONL.
set -u
cd "$(dirname "$0")/../.."

BIN=engine-rs/target/release/blokee-pentobi
CONFIG=engine-rs/configs/v4.2-ultra.json
PENTOBI=${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}
BOOK=${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}
OUT=${OUT:-tmp/x1}
THREADS=${THREADS:-5}
SUMMARY=$OUT/summary.txt
mkdir -p "$OUT"

run() {
  local label=$1
  shift
  echo "=== $label: $* (start $(date '+%F %T'))"
  "$BIN" --blokee "$CONFIG" --pentobi "$PENTOBI" --book "$BOOK" --budget 300 --threads "$THREADS" \
    --label "$label" --out "$OUT/$label.jsonl" "$@"
  local status=$?
  {
    echo "=== $label: $* (exit $status, $(date '+%F %T'))"
    if [ -f "$OUT/$label.failures.jsonl" ]; then
      echo "HARD FAILURES: $(wc -l < "$OUT/$label.failures.jsonl") (see $OUT/$label.failures.jsonl)"
    fi
    npx tsx scripts/aggregateMatches.ts "$OUT/$label.jsonl"
    echo
  } >> "$SUMMARY" 2>&1
  echo "=== $label done (exit $status, $(date '+%F %T'))"
}

run x1-l6a --mode one-blokee --level 6 --seeds 100 --seed-base 79000000
run x1-l6b --mode one-pentobi --level 6 --seeds 100 --seed-base 79000000
run x1-ladder-l5 --mode one-blokee --level 5 --seeds 40 --seed-base 79100000
run x1-ladder-l7 --mode one-blokee --level 7 --seeds 40 --seed-base 79200000
echo "queue done: $SUMMARY"
