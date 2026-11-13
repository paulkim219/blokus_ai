#!/usr/bin/env bash
# X2: where engine-rs/configs/v5.0-p4-ultra.json stands against Pentobi 31.0 (descriptive, no gate).
# Design: research_paper/v6_native_and_learning_preregistered.md, entry of 2026-11-13 05:59 CST.
#
#   nohup engine-rs/scripts/x2-run.sh A > tmp/x2/queue-A.log 2>&1 &   # compute (budget 600, 1200), reverse
#   nohup engine-rs/scripts/x2-run.sh B > tmp/x2/queue-B.log 2>&1 &   # ladder: level 5, level 7
#
# Uses a pinned copy of the P4 binary (tmp/x2/bin). Resumable: finished seed/seat pairs are skipped.
set -u
cd "$(dirname "$0")/../.."

CONFIG=${CONFIG:-engine-rs/configs/v5.0-p4-ultra.json}
PENTOBI=${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}
BOOK=${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}
OUT=${OUT:-tmp/x2}
THREADS=${THREADS:-5}
BIN=$OUT/bin/blokee-pentobi
mkdir -p "$OUT/bin"
if [ ! -x "$BIN" ]; then
  cp tmp/p4/bin/blokee-pentobi "$BIN"
  { date '+%F %T'; shasum -a 256 "$BIN"; echo "copied from tmp/p4/bin"; } > "$OUT/bin/PROVENANCE.txt"
fi

run() {  # run <label> <budget> <blokee-pentobi args...>
  local label=$1 budget=$2
  shift 2
  echo "=== $label: budget $budget $* (start $(date '+%F %T'))"
  "$BIN" --blokee "$CONFIG" --pentobi "$PENTOBI" --book "$BOOK" --budget "$budget" --threads "$THREADS" \
    --label "$label" --out "$OUT/$label.jsonl" "$@"
  local status=$?
  {
    echo "=== $label: budget $budget $* (exit $status, $(date '+%F %T'))"
    [ -f "$OUT/$label.failures.jsonl" ] && echo "HARD FAILURES: $(wc -l < "$OUT/$label.failures.jsonl")"
    npx tsx scripts/aggregateMatches.ts "$OUT/$label.jsonl"
    echo
  } >> "$OUT/summary-$QUEUE.txt" 2>&1
  echo "=== $label done (exit $status, $(date '+%F %T'))"
}

QUEUE=${1:-}
case "$QUEUE" in
  A)
    run x2-b600  600  --mode one-blokee  --level 6 --seeds 100 --seed-base 82000000
    run x2-b1200 1200 --mode one-blokee  --level 6 --seeds 100 --seed-base 82000000
    run x2-l6rev 300  --mode one-pentobi --level 6 --seeds 100 --seed-base 82200000
    ;;
  B)
    run x2-l5 300 --mode one-blokee --level 5 --seeds 100 --seed-base 79100000
    run x2-l7 300 --mode one-blokee --level 7 --seeds 40  --seed-base 79200000
    ;;
  *) echo "usage: $0 A|B" >&2; exit 2 ;;
esac
echo "X2 queue $QUEUE done"
