#!/usr/bin/env bash
# S1: config-only screen of single-knob `v4.2-ultra` variants against three Pentobi level-6 seats.
# Exploratory: a filter for what to build and confirm on fresh seeds, not evidence.
#
#   engine-rs/scripts/s1-screen.sh live              # liveness: 2 seeds per arm, compared with base
#   nohup engine-rs/scripts/s1-screen.sh run > tmp/s1/queue.log 2>&1 &
#   engine-rs/scripts/s1-screen.sh run W96 C0        # just these arms (base is always run first)
#   python3 engine-rs/scripts/s1_report.py tmp/s1    # table: advantage, paired Δ vs base, ms/move
#
# Arms and configs: engine-rs/scripts/s1_configs.py (writes tmp/s1/configs/s1-<ARM>.json).
# Match settings are x1-run.sh's: --mode one-blokee --level 6 --budget 300, Pentobi 31.0 with its
# Classic book, one Pentobi thread, seed = game seed. 100 seeds from 79,300,000; liveness seeds
# from 79,399,000. The binary is copied once to tmp/s1/bin so a rebuild of target/release during
# the screen cannot mix engines. Resumable: blokee-pentobi skips seed/seat pairs already in a JSONL.
set -u
cd "$(dirname "$0")/../.."

OUT=${OUT:-tmp/s1}
THREADS=${THREADS:-5}
SEEDS=${SEEDS:-100}
SEED_BASE=${SEED_BASE:-79300000}
LIVE_SEEDS=${LIVE_SEEDS:-2}
LIVE_BASE=${LIVE_BASE:-79399000}
PENTOBI=${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}
BOOK=${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}
ARMS_ALL="base W96 W400 W400open N96 O0 C0 R0 R100 MAXN B4 E30 A140"
BIN=$OUT/bin/blokee-pentobi
SUMMARY=$OUT/summary.txt

mkdir -p "$OUT/bin" "$OUT/live"
python3 engine-rs/scripts/s1_configs.py "$OUT/configs" > "$OUT/configs.log" || { cat "$OUT/configs.log"; exit 1; }
if [ ! -x "$BIN" ]; then
  cp engine-rs/target/release/blokee-pentobi "$BIN"
  { date '+%F %T'; shasum -a 256 "$BIN"; git rev-parse HEAD; git status --short engine-rs/src; } > "$OUT/bin/PROVENANCE.txt"
fi

play() {  # play <arm> <label> <out.jsonl> <seeds> <seed-base>
  local arm=$1 label=$2 out=$3 seeds=$4 base=$5
  "$BIN" --blokee "$OUT/configs/s1-$arm.json" --pentobi "$PENTOBI" --book "$BOOK" \
    --mode one-blokee --level 6 --budget 300 --threads "$THREADS" \
    --seeds "$seeds" --seed-base "$base" --label "$label" --out "$out" \
    --moves-out "${out%.jsonl}.moves.jsonl"
}

case "${1:-}" in
  live)
    for arm in $ARMS_ALL; do
      echo "=== live $arm ($(date '+%F %T'))"
      play "$arm" "s1-live-$arm" "$OUT/live/s1-live-$arm.jsonl" "$LIVE_SEEDS" "$LIVE_BASE" 2>&1 | grep -E "unsupported|panic|HARD|wall ms|wrote" || true
    done
    python3 engine-rs/scripts/s1_report.py "$OUT" --live
    ;;
  run)
    shift
    arms=${*:-$ARMS_ALL}
    case " $arms " in *" base "*) ;; *) arms="base $arms" ;; esac
    for arm in $arms; do
      label="s1-$arm"
      echo "=== $label start $(date '+%F %T') load: $(uptime | sed 's/.*load averages*: //')"
      play "$arm" "$label" "$OUT/$label.jsonl" "$SEEDS" "$SEED_BASE"
      status=$?
      echo "=== $label done (exit $status) $(date '+%F %T') load: $(uptime | sed 's/.*load averages*: //')"
      {
        echo "=== $label (exit $status, $(date '+%F %T'))"
        [ -f "$OUT/$label.failures.jsonl" ] && echo "HARD FAILURES: $(wc -l < "$OUT/$label.failures.jsonl")"
        npx tsx scripts/aggregateMatches.ts "$OUT/$label.jsonl"
        echo
      } >> "$SUMMARY" 2>&1
    done
    echo "queue done: $SUMMARY"
    ;;
  *)
    echo "usage: $0 live | run [ARM ...]   (arms: $ARMS_ALL)" >&2
    exit 2
    ;;
esac
