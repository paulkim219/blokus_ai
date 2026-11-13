#!/usr/bin/env bash
# P4/P5 (first v5.0 port: candidate generation and priors). Seeds, sizes and the acceptance rule are
# the 2026-11-13 entry of research_paper/v6_native_and_learning_preregistered.md ("P4/P5").
#
#   engine-rs/scripts/p4-screen.sh pin                # copy the binaries to tmp/p4/bin (once)
#   engine-rs/scripts/p4-screen.sh identity           # identity gates with every new option off
#   engine-rs/scripts/p4-screen.sh live               # liveness: 2 seeds per arm, compared with base
#   nohup engine-rs/scripts/p4-screen.sh run > tmp/p4/queue.log 2>&1 &      # screen: base + arms
#   nohup engine-rs/scripts/p4-screen.sh confirm ARM > tmp/p4/confirm.log 2>&1 &   # confirmation
#   nohup engine-rs/scripts/p4-screen.sh match ARM > tmp/p4/match.log 2>&1 &       # vs v4.2-ultra
#   engine-rs/scripts/p4-screen.sh cost [N]           # ms/move and iterations/s, every arm, same positions
#   python3 engine-rs/scripts/p4_report.py tmp/p4     # tables
#
# Arms and configs: engine-rs/scripts/p4_configs.py (tmp/p4/configs/p4-<ARM>.json). Match settings are
# x1-run.sh's: --mode one-blokee --level 6 --budget 300, Pentobi 31.0 with its Classic book, one
# Pentobi thread, seed = game seed. Screen: 100 seeds from 79,500,000. Confirmation: 200 seeds from
# 79,600,000 (base and the chosen arm). Direct match: 200 seeds from 80,000,000 with blokee-match.
# Liveness seeds from 79,599,000 (outside both blocks). Binaries are copied once to tmp/p4/bin so a
# rebuild of target/release cannot mix engines. Resumable: blokee-pentobi skips seed/seat pairs
# already in a JSONL; `match` restarts from scratch if its JSONL is incomplete (blokee-match does not
# resume), keeping the partial file as .partial.
set -u
cd "$(dirname "$0")/../.."

OUT=${OUT:-tmp/p4}
THREADS=${THREADS:-5}
PENTOBI=${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}
BOOK=${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}
ARMS_SCREEN="FULLord SLfit FULLfit FULLfitI SLfitI FULLfitN10 FULLfitW"
BIN=$OUT/bin
SUMMARY=$OUT/summary.txt
load() { uptime | sed 's/.*load averages*: //'; }

mkdir -p "$OUT/live" "$OUT/screen" "$OUT/confirm" "$OUT/match" "$OUT/identity" "$OUT/cost"
python3 engine-rs/scripts/p4_configs.py "$OUT/configs" > "$OUT/configs.log" || { cat "$OUT/configs.log"; exit 1; }

pin() {
  if [ ! -x "$BIN/blokee-pentobi" ]; then
    mkdir -p "$BIN"
    cp engine-rs/target/release/blokee-pentobi engine-rs/target/release/blokee-match engine-rs/target/release/blokee-selfplay "$BIN/"
    cp engine-rs/target/release/examples/p4_cost "$BIN/" 2>/dev/null
    git diff > "$BIN/engine.diff"; cp engine-rs/src/feature_prior.rs "$BIN/"
    { date '+%F %T'; git rev-parse HEAD; git status --short; shasum -a 256 "$BIN"/*; } > "$BIN/PROVENANCE.txt"
  fi
}

play() {  # play <arm> <label> <out.jsonl> <seeds> <seed-base>
  local arm=$1 label=$2 out=$3 seeds=$4 base=$5
  "$BIN/blokee-pentobi" --blokee "$OUT/configs/p4-$arm.json" --pentobi "$PENTOBI" --book "$BOOK" \
    --mode one-blokee --level 6 --budget 300 --threads "$THREADS" \
    --seeds "$seeds" --seed-base "$base" --label "$label" --out "$out" \
    --moves-out "${out%.jsonl}.moves.jsonl"
}

block() {  # block <arm> <dir> <prefix> <seeds> <seed-base>
  local arm=$1 dir=$2 prefix=$3 seeds=$4 base=$5
  local label="$prefix-$arm"
  echo "=== $label start $(date '+%F %T') load: $(load)"
  play "$arm" "$label" "$dir/$label.jsonl" "$seeds" "$base"
  local status=$?
  echo "=== $label done (exit $status) $(date '+%F %T') load: $(load)"
  {
    echo "=== $label (exit $status, $(date '+%F %T'), load $(load))"
    [ -f "$dir/$label.failures.jsonl" ] && echo "HARD FAILURES: $(wc -l < "$dir/$label.failures.jsonl")"
    npx tsx scripts/aggregateMatches.ts "$dir/$label.jsonl"
    echo
  } >> "$SUMMARY" 2>&1
}

case "${1:-}" in
  pin)
    pin
    cat "$BIN/PROVENANCE.txt"
    ;;
  identity)
    pin
    I=$OUT/identity
    C=engine-rs/configs/v4.2-ultra.json
    BEFORE=${BEFORE:-$OUT/bin-before}
    echo "=== identity start $(date '+%F %T') load: $(load)"
    # 1. v4.2-ultra mirror, and the identity point (native.candidates present, all off) vs v4.2-ultra.
    rm -f "$I"/mirror-*.jsonl
    "$BIN/blokee-match" --challenger $C --champion $C --seeds 20 --seed-base 80900000 --budget 300 --threads "$THREADS" \
      --label mirror-v42u --out "$I/mirror-v42u.jsonl" 2>&1 | tail -1
    "$BIN/blokee-match" --challenger "$OUT/configs/p4-ID.json" --champion $C --seeds 20 --seed-base 80900000 --budget 300 --threads "$THREADS" \
      --label mirror-ID --out "$I/mirror-ID.jsonl" 2>&1 | tail -1
    "$BEFORE/blokee-match" --challenger $C --champion $C --seeds 20 --seed-base 80900000 --budget 300 --threads "$THREADS" \
      --label mirror-v42u --out "$I/mirror-v42u-before.jsonl" 2>&1 | tail -1
    for f in mirror-v42u mirror-ID mirror-v42u-before; do echo "--- $f"; npx tsx scripts/aggregateMatches.ts "$I/$f.jsonl"; done
    # 2. self-play bytes: binary before the change vs now (v4.2-ultra and the identity point), one thread.
    rm -rf "$I"/sp-*
    "$BEFORE/blokee-selfplay" --config $C --games 6 --budget 300 --threads 1 --seed-base 80950000 --out "$I/sp-before" 2>/dev/null
    "$BIN/blokee-selfplay" --config $C --games 6 --budget 300 --threads 1 --seed-base 80950000 --out "$I/sp-after" 2>/dev/null
    "$BIN/blokee-selfplay" --config "$OUT/configs/p4-ID.json" --games 6 --budget 300 --threads 1 --seed-base 80950000 --out "$I/sp-ID" 2>/dev/null
    for d in sp-after sp-ID; do
      if cmp -s "$I/sp-before/shard-00.bin" "$I/$d/shard-00.bin" && cmp -s "$I/sp-before/games.jsonl" "$I/$d/games.jsonl"; then
        echo "self-play $d: shard-00.bin and games.jsonl byte-identical to the binary before the change ($(wc -c < "$I/$d/shard-00.bin") bytes, $(wc -l < "$I/$d/games.jsonl") games)"
      else
        echo "self-play $d: DIFFERS from the binary before the change"
      fi
    done
    shasum -a 256 "$I"/sp-*/shard-00.bin "$I"/sp-*/games.jsonl
    # 3. Pentobi bridge: v4.2-ultra and the identity point play the same games as the old binary.
    rm -f "$I"/br-*
    for pair in "before:$BEFORE/blokee-pentobi:$C" "after:$BIN/blokee-pentobi:$C" "ID:$BIN/blokee-pentobi:$OUT/configs/p4-ID.json"; do
      IFS=: read name bin cfg <<< "$pair"
      "$bin" --blokee "$cfg" --blokee-name v4.2-ultra --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --level 6 --budget 300 \
        --threads "$THREADS" --seeds 2 --seed-base 80980000 --label br-id --out "$I/br-$name.jsonl" --moves-out "$I/br-$name.moves.jsonl" 2>/dev/null
    done
    python3 - "$I" <<'EOF'
import json, sys
d = sys.argv[1]
def games(n):
    return {(g["seed"], g["seat"]): (g["moves"]) for g in map(json.loads, open(f"{d}/br-{n}.moves.jsonl"))}
b = games("before")
for n in ("after", "ID"):
    a = games(n)
    same = sum(a[k] == b[k] for k in b if k in a)
    print(f"bridge {n}: {same}/{len(b)} games move-for-move equal to the binary before the change")
EOF
    echo "=== identity done $(date '+%F %T') load: $(load)"
    ;;
  live)
    pin
    for arm in base $ARMS_SCREEN; do
      echo "=== live $arm ($(date '+%F %T'), load $(load))"
      play "$arm" "p4-live-$arm" "$OUT/live/p4-live-$arm.jsonl" 2 79599000 2>&1 | grep -E "unsupported|panic|HARD|wall ms|wrote" || true
    done
    python3 engine-rs/scripts/p4_report.py "$OUT" --live
    ;;
  run)
    pin
    shift
    arms=${*:-$ARMS_SCREEN}
    case " $arms " in *" base "*) ;; *) arms="base $arms" ;; esac
    for arm in $arms; do
      block "$arm" "$OUT/screen" p4s 100 79500000
    done
    echo "screen queue done: $SUMMARY"
    ;;
  confirm)
    pin
    arm=${2:?confirm needs an arm}
    for a in base "$arm"; do
      block "$a" "$OUT/confirm" p4c 200 79600000
    done
    python3 ml/seat/paired_report.py "$OUT/confirm/p4c-$arm.jsonl" "$OUT/confirm/p4c-base.jsonl" --label "confirm $arm vs base" | tee -a "$SUMMARY"
    echo "confirmation done: $SUMMARY"
    ;;
  match)
    pin
    arm=${2:?match needs an arm}
    out=$OUT/match/p4m-$arm.jsonl
    if [ -f "$out" ] && [ "$(wc -l < "$out")" -lt 800 ]; then mv "$out" "$out.partial.$(date +%s)"; fi
    if [ ! -f "$out" ]; then
      echo "=== p4m-$arm start $(date '+%F %T') load: $(load)"
      "$BIN/blokee-match" --challenger "$OUT/configs/p4-$arm.json" --champion engine-rs/configs/v4.2-ultra.json \
        --seeds 200 --seed-base 80000000 --budget 300 --threads "$THREADS" --label "p4m-$arm" --out "$out" 2>&1 | tr '\r' '\n' | tail -3
      echo "=== p4m-$arm done $(date '+%F %T') load: $(load)"
    fi
    { echo "=== p4m-$arm vs v4.2-ultra (blokee-match, 200 seeds from 80,000,000; $(date '+%F %T'))"; npx tsx scripts/aggregateMatches.ts "$out"; echo; } >> "$SUMMARY" 2>&1
    tail -20 "$SUMMARY"
    ;;
  cost)
    pin
    n=${2:-150}
    cfgs=""
    for a in base $ARMS_SCREEN; do cfgs="$cfgs $OUT/configs/p4-$a.json"; done
    echo "=== cost start $(date '+%F %T') load: $(load)"
    "$BIN/p4_cost" tmp/d1/x1-l6a.moves.jsonl "$n" "$THREADS" "$OUT/cost/cost.csv" $cfgs
    echo "=== cost done $(date '+%F %T') load: $(load)"
    python3 engine-rs/scripts/p4_cost_report.py "$OUT/cost/cost.csv" base $ARMS_SCREEN | tee "$OUT/cost/cost.md"
    ;;
  *)
    echo "usage: $0 pin | identity | live | run [ARM ...] | confirm ARM | match ARM | cost [N]   (arms: $ARMS_SCREEN)" >&2
    exit 2
    ;;
esac
