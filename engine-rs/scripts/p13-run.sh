#!/usr/bin/env bash
# P1–P3 (rollout over all legal moves with incremental lists, rank reward): identity gates, a clean
# cost run, liveness, the screen against three Pentobi level-6 seats, selection, confirmation (with
# an equal-time arm when the selected arm costs more than 1.25× base), and the direct match.
# Preregistered 2026-11-13 in research_paper/v6_native_and_learning_preregistered.md ("P1–P3");
# results in research_paper/v5_p1_p3_rollout_results.md.
#
#   engine-rs/scripts/p13-run.sh pin             # copy the binaries built from HEAD to tmp/p13/bin (once)
#   engine-rs/scripts/p13-run.sh identity        # parity of every option at its identity point
#   engine-rs/scripts/p13-run.sh cost [N]        # ms/move, every arm, same positions; NOTHING ELSE RUNNING
#   engine-rs/scripts/p13-run.sh live            # liveness: 2 seeds from 83,900,000 per arm
#   nohup engine-rs/scripts/p13-run.sh chain > tmp/p13/chain.log 2>&1 &   # screen -> select -> confirm
#   engine-rs/scripts/p13-run.sh match CONFIG    # accepted config vs three v5.0-p4-ultra seats
#   python3 engine-rs/scripts/p13_report.py tmp/p13 [--live|--confirm|--select|--cost]
#
# Match settings are S2's: --mode one-blokee --level 6 --budget 300, Pentobi 31.0 with its Classic
# book, one Pentobi thread, seed = game seed, one seed = 4 games (the Blokee seat rotated).
# Screen: SEEDS=100 from 83,000,000. Confirmation: CSEEDS=200 from 83,100,000, base and the arm(s)
# started together. Direct match: 200 seeds from 83,200,000. Resumable: blokee-pentobi skips
# seed/seat pairs already in a JSONL. Sentinel lines: "P13 SCREEN DONE", "P13 CHAIN DONE".
set -u
cd "$(dirname "$0")/../.."

OUT=${OUT:-tmp/p13}
THREADS=${THREADS:-10}
SEEDS=${SEEDS:-100}
SEED_BASE=${SEED_BASE:-83000000}
CSEEDS=${CSEEDS:-200}
CSEED_BASE=${CSEED_BASE:-83100000}
MSEEDS=${MSEEDS:-200}
MSEED_BASE=${MSEED_BASE:-83200000}
LIVE_SEEDS=${LIVE_SEEDS:-2}
LIVE_BASE=${LIVE_BASE:-83900000}
PENTOBI=${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}
BOOK=${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}
ARMS_ALL="P1S P1L P1X P3A P3B P1LP3B"
BASE_CFG=engine-rs/configs/v5.0-p4-ultra.json
BIN=$OUT/bin
BEFORE=$OUT/bin-before
SUMMARY=$OUT/summary.txt
load() { uptime | sed 's/.*load averages*: //'; }

mkdir -p "$OUT/live" "$OUT/screen" "$OUT/confirm" "$OUT/match" "$OUT/identity" "$OUT/cost"
python3 engine-rs/scripts/p13_configs.py "$OUT/configs" > "$OUT/configs.log" || { cat "$OUT/configs.log"; exit 1; }

pin() {
  if [ ! -x "$BIN/blokee-pentobi" ]; then
    [ -z "$(git status --short engine-rs/src engine-rs/Cargo.toml)" ] || { echo "engine sources not committed; refusing to pin" >&2; exit 1; }
    mkdir -p "$BIN"
    cp engine-rs/target/release/blokee-pentobi engine-rs/target/release/blokee-match engine-rs/target/release/blokee-selfplay "$BIN/"
    cp engine-rs/target/release/examples/p4_cost "$BIN/"
    { date '+%F %T'; echo "HEAD $(git rev-parse HEAD)"; git status --short; shasum -a 256 "$BIN"/*; } > "$BIN/PROVENANCE.txt"
  fi
}

play() {  # play <config> <label> <out.jsonl> <seeds> <seed-base> <threads>
  local cfg=$1 label=$2 out=$3 seeds=$4 base=$5 threads=$6
  "$BIN/blokee-pentobi" --blokee "$cfg" --pentobi "$PENTOBI" --book "$BOOK" \
    --mode one-blokee --level 6 --budget 300 --threads "$threads" \
    --seeds "$seeds" --seed-base "$base" --label "$label" --out "$out" \
    --moves-out "${out%.jsonl}.moves.jsonl"
}

block() {  # block <arm> <dir> <prefix> <seeds> <seed-base> <threads>
  local arm=$1 dir=$2 prefix=$3 seeds=$4 base=$5 threads=$6
  local label="$prefix-$arm"
  echo "=== $label start $(date '+%F %T') load: $(load)"
  play "$OUT/configs/p13-$arm.json" "$label" "$dir/$label.jsonl" "$seeds" "$base" "$threads" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|wrote|rror" || true
  echo "=== $label done $(date '+%F %T') load: $(load)"
  {
    echo "=== $label ($(date '+%F %T'), load $(load))"
    [ -f "$dir/$label.failures.jsonl" ] && echo "HARD FAILURES: $(wc -l < "$dir/$label.failures.jsonl")"
    npx tsx scripts/aggregateMatches.ts "$dir/$label.jsonl"
    echo
  } >> "$SUMMARY" 2>&1
}

fixed_arms() {
  [ -f "$OUT/ARMS" ] || { echo "no $OUT/ARMS: fix the arms before the screen" >&2; exit 1; }
  cat "$OUT/ARMS"
}

case "${1:-}" in
  pin)
    pin; cat "$BIN/PROVENANCE.txt" ;;
  identity)
    pin
    I=$OUT/identity
    C=$BASE_CFG
    echo "=== identity start $(date '+%F %T') load: $(load)"
    # 1. v5.0-p4-ultra mirror (new binary), the identity point vs v5.0-p4-ultra, and the old binary's mirror.
    rm -f "$I"/mirror-*.jsonl
    "$BIN/blokee-match" --challenger $C --champion $C --seeds 20 --seed-base 80900000 --budget 300 --threads "$THREADS" \
      --label mirror-p4u --out "$I/mirror-p4u.jsonl" 2>&1 | tail -1
    "$BIN/blokee-match" --challenger "$OUT/configs/p13-ID.json" --champion $C --seeds 20 --seed-base 80900000 --budget 300 --threads "$THREADS" \
      --label mirror-ID --out "$I/mirror-ID.jsonl" 2>&1 | tail -1
    "$BEFORE/blokee-match" --challenger $C --champion $C --seeds 20 --seed-base 80900000 --budget 300 --threads "$THREADS" \
      --label mirror-p4u --out "$I/mirror-p4u-before.jsonl" 2>&1 | tail -1
    for f in mirror-p4u mirror-ID mirror-p4u-before; do echo "--- $f"; npx tsx scripts/aggregateMatches.ts "$I/$f.jsonl"; done
    python3 - "$I" <<'EOF'
import json, sys
d = sys.argv[1]
def scores(n):
    return {(g["seed"], g["seat"]): g["scores"] for g in map(json.loads, open(f"{d}/{n}.jsonl"))}
b = scores("mirror-p4u-before")
for n in ("mirror-p4u", "mirror-ID"):
    a = scores(n)
    same = sum(a[k] == b[k] for k in b if k in a)
    print(f"{n}: {same}/{len(b)} games with every seat's score equal to the old binary's mirror")
EOF
    # 2. self-play bytes: old binary vs new (v5.0-p4-ultra and the identity point), one thread.
    rm -rf "$I"/sp-*
    "$BEFORE/blokee-selfplay" --config $C --games 6 --budget 300 --threads 1 --seed-base 80950000 --out "$I/sp-before" 2>/dev/null
    "$BIN/blokee-selfplay" --config $C --games 6 --budget 300 --threads 1 --seed-base 80950000 --out "$I/sp-after" 2>/dev/null
    "$BIN/blokee-selfplay" --config "$OUT/configs/p13-ID.json" --games 6 --budget 300 --threads 1 --seed-base 80950000 --out "$I/sp-ID" 2>/dev/null
    for d in sp-after sp-ID; do
      if cmp -s "$I/sp-before/shard-00.bin" "$I/$d/shard-00.bin" && cmp -s "$I/sp-before/games.jsonl" "$I/$d/games.jsonl"; then
        echo "self-play $d: shard-00.bin and games.jsonl byte-identical to the old binary ($(wc -c < "$I/$d/shard-00.bin") bytes, $(wc -l < "$I/$d/games.jsonl") games)"
      else
        echo "self-play $d: DIFFERS from the old binary"
      fi
    done
    shasum -a 256 "$I"/sp-*/shard-00.bin "$I"/sp-*/games.jsonl
    # 3. Pentobi bridge: v5.0-p4-ultra and the identity point play the same games as the old binary.
    rm -f "$I"/br-*
    for pair in "before:$BEFORE/blokee-pentobi:$C" "after:$BIN/blokee-pentobi:$C" "ID:$BIN/blokee-pentobi:$OUT/configs/p13-ID.json"; do
      IFS=: read name bin cfg <<< "$pair"
      "$bin" --blokee "$cfg" --blokee-name v5.0-p4-ultra --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --level 6 --budget 300 \
        --threads 8 --seeds 2 --seed-base 80980000 --label br-id --out "$I/br-$name.jsonl" --moves-out "$I/br-$name.moves.jsonl" 2>/dev/null
    done
    python3 - "$I" <<'EOF'
import json, sys
d = sys.argv[1]
def games(n):
    return {(g["seed"], g["seat"]): g["moves"] for g in map(json.loads, open(f"{d}/br-{n}.moves.jsonl"))}
b = games("before")
for n in ("after", "ID"):
    a = games(n)
    same = sum(a[k] == b[k] for k in b if k in a)
    print(f"bridge {n}: {same}/{len(b)} games move-for-move equal to the old binary")
EOF
    echo "=== identity done $(date '+%F %T') load: $(load)"
    ;;
  cost)
    pin
    n=${2:-150}
    cfgs=""
    for a in base ID $ARMS_ALL; do cfgs="$cfgs $OUT/configs/p13-$a.json"; done
    echo "=== cost start $(date '+%F %T') load: $(load)"
    "$BIN/p4_cost" tmp/d1/x1-l6a.moves.jsonl "$n" 2 "$OUT/cost/cost.csv" $cfgs
    echo "=== cost done $(date '+%F %T') load: $(load)"
    python3 engine-rs/scripts/p4_cost_report.py "$OUT/cost/cost.csv" base ID $ARMS_ALL | tee "$OUT/cost/cost.md" ;;
  live)
    pin
    echo "$ARMS_ALL" > "$OUT/ARMS_LIVE"
    for arm in base $ARMS_ALL; do
      echo "=== live $arm ($(date '+%F %T'), load $(load))"
      play "$OUT/configs/p13-$arm.json" "p13-live-$arm" "$OUT/live/p13-live-$arm.jsonl" "$LIVE_SEEDS" "$LIVE_BASE" "$THREADS" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|wrote|rror" || true
    done
    python3 engine-rs/scripts/p13_report.py "$OUT" --live | tee "$OUT/live.md" ;;
  chain)
    pin
    arms=$(fixed_arms)
    echo "P13 chain start $(date '+%F %T'); screen arms: $arms; threads $THREADS"
    for arm in base $arms; do
      block "$arm" "$OUT/screen" p13s "$SEEDS" "$SEED_BASE" "$THREADS"
    done
    echo "P13 SCREEN DONE $(date '+%F %T')"
    python3 engine-rs/scripts/p13_report.py "$OUT" > "$OUT/screen.md"
    cat "$OUT/screen.md"
    python3 engine-rs/scripts/p13_report.py "$OUT" --select > "$OUT/selected.txt" 2> "$OUT/selection.log"
    cat "$OUT/selection.log"
    sel=$(head -1 "$OUT/selected.txt")
    if [ -n "$sel" ]; then
      ratio=$(python3 engine-rs/scripts/p13_report.py "$OUT" --cost-ratio "$sel")
      cargs="base $sel"
      if python3 -c "import sys; sys.exit(0 if float('$ratio') > 1.25 else 1)"; then
        python3 engine-rs/scripts/p13_configs.py "$OUT/configs" --equal-time "$sel" "$ratio" >> "$OUT/configs.log"
        cargs="$cargs $sel-ET"
      fi
      echo "P13 confirmation start $(date '+%F %T'): $cargs (clean cost ratio $ratio)"
      echo "$cargs" > "$OUT/CONFIRM_ARMS"
      n=$(echo $cargs | wc -w | tr -d ' ')
      per=$(( THREADS / n )); [ "$per" -ge 1 ] || per=1
      for arm in $cargs; do
        block "$arm" "$OUT/confirm" p13c "$CSEEDS" "$CSEED_BASE" "$per" &
      done
      wait
      python3 engine-rs/scripts/p13_report.py "$OUT" --confirm > "$OUT/confirm.md"
    else
      echo "No arm cleared the screen (paired CI lower bound > 0); no confirmation run, as preregistered." > "$OUT/confirm.md"
    fi
    cat "$OUT/confirm.md"
    echo "P13 CHAIN DONE $(date '+%F %T')" ;;
  match)
    pin
    cfg=${2:?config}
    name=$(basename "$cfg" .json)
    echo "=== match $name start $(date '+%F %T') load: $(load)"
    "$BIN/blokee-match" --challenger "$cfg" --champion $BASE_CFG --seeds "$MSEEDS" --seed-base "$MSEED_BASE" --budget 300 \
      --threads "$THREADS" --label "match-$name" --out "$OUT/match/match-$name.jsonl" 2>&1 | tail -1
    npx tsx scripts/aggregateMatches.ts "$OUT/match/match-$name.jsonl" | tee "$OUT/match/match-$name.txt"
    echo "P13 MATCH DONE $(date '+%F %T')" ;;
  *)
    echo "usage: $0 pin | identity | cost [N] | live | chain | match CONFIG   (arms: $ARMS_ALL)" >&2
    exit 2 ;;
esac
