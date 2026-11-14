#!/usr/bin/env bash
# S4 (speed of the interior-expansion search, identical output) and the Stage-3 prior re-fit matches.
# Preregistered 2026-11-13 in research_paper/v6_native_and_learning_preregistered.md ("S4", "N11");
# results in research_paper/v5_speed_and_prior_refit_results.md.
#
#   engine-rs/scripts/s4-run.sh pin              # copy the binaries built from HEAD to tmp/s4/bin (once)
#   engine-rs/scripts/s4-run.sh identity         # new binary vs tmp/s4/bin-before (pre-change), 3 configs
#   engine-rs/scripts/s4-run.sh cost [N]         # clean ms/move, old vs new binary, ABAB; NOTHING ELSE RUNNING
#   engine-rs/scripts/s4-run.sh calib SCALE...   # new binary, v5.0-p4i-ultra at other iterationScales
#   nohup engine-rs/scripts/s4-run.sh confirm > tmp/s4/confirm.log 2>&1 &   # re-timed base vs v5.0-p4i-ultra
#   engine-rs/scripts/s4-run.sh reuse [GAMES]    # Stage 2: P8 reuse probe on v5.0-p4i-ultra games
#   python3 engine-rs/scripts/s4_report.py ...   # read-out
#
# Match settings as P9/P10: --mode one-blokee --level 6 --budget 300, Pentobi 31.0 with its Classic
# book, one Pentobi thread, seed = game seed, one seed = 4 games (the Blokee seat rotated). Confirmation:
# 400 seeds from 87,000,000, both arms started together, 5 threads each. Resumable: blokee-pentobi
# skips seed/seat pairs already in a JSONL. Sentinel lines: "S4 CONFIRM DONE". Run every chain under
# caffeinate -i -s -m -w <pid>.
set -u
cd "$(dirname "$0")/../.."

OUT=${OUT:-tmp/s4}
THREADS=${THREADS:-10}
CSEEDS=${CSEEDS:-400}
CSEED_BASE=${CSEED_BASE:-87000000}
PENTOBI=${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}
BOOK=${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}
CFG=engine-rs/configs
CONFIGS="v5.0-p4i-ultra v5.0-p4-ultra v4.2-ultra"
BIN=$OUT/bin
BEFORE=$OUT/bin-before
SUMMARY=$OUT/summary.txt
load() { uptime | sed 's/.*load averages*: //'; }

mkdir -p "$OUT/identity" "$OUT/cost" "$OUT/confirm" "$OUT/configs" "$OUT/reuse"

pin() {
  if [ ! -x "$BIN/blokee-pentobi" ]; then
    [ -z "$(git status --short engine-rs/src engine-rs/Cargo.toml engine-rs/examples)" ] || { echo "engine sources not committed; refusing to pin" >&2; exit 1; }
    mkdir -p "$BIN"
    cp engine-rs/target/release/blokee-pentobi engine-rs/target/release/blokee-match engine-rs/target/release/blokee-selfplay "$BIN/"
    cp engine-rs/target/release/examples/p4_cost engine-rs/target/release/examples/s4_identity engine-rs/target/release/examples/p67_probe "$BIN/"
    { date '+%F %T'; echo "HEAD $(git rev-parse HEAD)"; git status --short; shasum -a 256 "$BIN"/*; } > "$BIN/PROVENANCE.txt"
  fi
}

play() {  # play <bin-dir> <config> <label> <out.jsonl> <seeds> <seed-base> <threads>
  local bin=$1 cfg=$2 label=$3 out=$4 seeds=$5 base=$6 threads=$7
  "$bin/blokee-pentobi" --blokee "$cfg" --pentobi "$PENTOBI" --book "$BOOK" \
    --mode one-blokee --level 6 --budget 300 --threads "$threads" \
    --seeds "$seeds" --seed-base "$base" --label "$label" --out "$out" \
    --moves-out "${out%.jsonl}.moves.jsonl"
}

block() {  # block <config> <label> <dir> <seeds> <seed-base> <threads>
  local cfg=$1 label=$2 dir=$3 seeds=$4 base=$5 threads=$6
  echo "=== $label start $(date '+%F %T') load: $(load)"
  play "$BIN" "$cfg" "$label" "$dir/$label.jsonl" "$seeds" "$base" "$threads" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|wrote|rror" || true
  echo "=== $label done $(date '+%F %T') load: $(load)"
  {
    echo "=== $label ($(date '+%F %T'), load $(load))"
    [ -f "$dir/$label.failures.jsonl" ] && echo "HARD FAILURES: $(wc -l < "$dir/$label.failures.jsonl")"
    npx tsx scripts/aggregateMatches.ts "$dir/$label.jsonl"
    echo
  } >> "$SUMMARY" 2>&1
}

case "${1:-}" in
  pin)
    pin; cat "$BIN/PROVENANCE.txt" ;;
  identity)
    pin
    I=$OUT/identity
    echo "=== identity start $(date '+%F %T') load: $(load)"
    # 1. Every search's complete ranked output (moves, visits, value bits), 300 positions (all seats,
    #    own moves 0+; X1 level-6 games and X3 level-7 games), three configs.
    F=tmp/d1/x1-l6a.moves.jsonl,tmp/x3/x3-l7-p4i.moves.jsonl
    "$BEFORE/s4_identity" "$I/dump-before.txt" 150 10 $F $CFG/v5.0-p4i-ultra.json $CFG/v5.0-p4-ultra.json $CFG/v4.2-ultra.json 2>/dev/null
    "$BIN/s4_identity" "$I/dump-after.txt" 150 10 $F $CFG/v5.0-p4i-ultra.json $CFG/v5.0-p4-ultra.json $CFG/v4.2-ultra.json 2>/dev/null
    if cmp -s "$I/dump-before.txt" "$I/dump-after.txt"; then
      echo "dump: $(wc -l < "$I/dump-after.txt") searches (300 positions x 3 configs), byte-identical ($(grep -c ' Search ' "$I/dump-after.txt") tree searches)"
    else
      echo "dump: DIFFERS"; cmp "$I/dump-before.txt" "$I/dump-after.txt"
    fi
    for c in $CONFIGS; do
      C=$CFG/$c.json
      # 2. Mirror with the new blokee-match (must read 0.00) and per-game scores equal to the old binary's mirror.
      rm -f "$I"/mirror-$c*.jsonl
      "$BIN/blokee-match" --challenger $C --champion $C --seeds 20 --seed-base 80900000 --budget 300 --threads "$THREADS" \
        --label mirror-$c --out "$I/mirror-$c.jsonl" > /dev/null 2>&1
      "$BEFORE/blokee-match" --challenger $C --champion $C --seeds 20 --seed-base 80900000 --budget 300 --threads "$THREADS" \
        --label mirror-$c --out "$I/mirror-$c-before.jsonl" > /dev/null 2>&1
      echo "--- $c mirror (new binary)"; npx tsx scripts/aggregateMatches.ts "$I/mirror-$c.jsonl" | grep -E "Advantage|First place"
      python3 - "$I" "$c" <<'EOF'
import json, sys
d, c = sys.argv[1], sys.argv[2]
def scores(n):
    return {(g["seed"], g["seat"]): g["scores"] for g in map(json.loads, open(f"{d}/{n}.jsonl"))}
b, a = scores(f"mirror-{c}-before"), scores(f"mirror-{c}")
print(f"{c} mirror: {sum(a.get(k) == b[k] for k in b)}/{len(b)} games with every seat's score equal to the old binary's mirror")
EOF
      # 3. Self-play: 6 games, one thread; shard and games.jsonl byte-identical.
      rm -rf "$I"/sp-$c-*
      "$BEFORE/blokee-selfplay" --config $C --games 6 --budget 300 --threads 1 --seed-base 80950000 --out "$I/sp-$c-before" 2>/dev/null
      "$BIN/blokee-selfplay" --config $C --games 6 --budget 300 --threads 1 --seed-base 80950000 --out "$I/sp-$c-after" 2>/dev/null
      if cmp -s "$I/sp-$c-before/shard-00.bin" "$I/sp-$c-after/shard-00.bin" && cmp -s "$I/sp-$c-before/games.jsonl" "$I/sp-$c-after/games.jsonl"; then
        echo "$c self-play: shard-00.bin and games.jsonl byte-identical ($(wc -c < "$I/sp-$c-after/shard-00.bin") bytes, $(wc -l < "$I/sp-$c-after/games.jsonl") games; sha256 $(shasum -a 256 "$I/sp-$c-after/shard-00.bin" | cut -c1-8)… / $(shasum -a 256 "$I/sp-$c-after/games.jsonl" | cut -c1-8)…)"
      else
        echo "$c self-play: DIFFERS from the old binary"
      fi
      # 4. Pentobi bridge, 2 seeds (8 games against level 6): move for move.
      rm -f "$I"/br-$c-*
      play "$BEFORE" $C br-id "$I/br-$c-before.jsonl" 2 80980000 8 > /dev/null 2>&1
      play "$BIN" $C br-id "$I/br-$c-after.jsonl" 2 80980000 8 > /dev/null 2>&1
      python3 - "$I" "$c" <<'EOF'
import json, sys
d, c = sys.argv[1], sys.argv[2]
def games(n):
    return {(g["seed"], g["seat"]): g["moves"] for g in map(json.loads, open(f"{d}/br-{c}-{n}.moves.jsonl"))}
b, a = games("before"), games("after")
print(f"{c} bridge: {sum(a.get(k) == b[k] for k in b)}/{len(b)} games move-for-move equal to the old binary")
EOF
    done
    echo "=== identity done $(date '+%F %T') load: $(load)"
    ;;
  cost)
    pin
    n=${2:-150}
    cfgs=""; for c in $CONFIGS; do cfgs="$cfgs $CFG/$c.json"; done
    echo "$CONFIGS" > "$OUT/cost/names"
    echo "=== cost start $(date '+%F %T') load: $(load)"
    for round in 1 2; do
      for side in before after; do
        bin=$BEFORE; [ $side = after ] && bin=$BIN
        echo "--- round $round $side $(date '+%T') load: $(load)"
        "$bin/p4_cost" tmp/d1/x1-l6a.moves.jsonl "$n" 2 "$OUT/cost/cost-$side-$round.csv" $cfgs 2>/dev/null
      done
    done
    echo "=== cost done $(date '+%F %T') load: $(load)"
    python3 engine-rs/scripts/s4_report.py --cost "$OUT/cost" | tee "$OUT/cost/cost.md" ;;
  calib)
    pin
    shift
    names="base"; cfgs="$CFG/v5.0-p4i-ultra.json"
    for s in "$@"; do
      python3 - "$CFG/v5.0-p4i-ultra.json" "$OUT/configs/calib-$s.json" "$s" <<'EOF'
import json, sys
c = json.load(open(sys.argv[1])); c["search"]["iterationScale"] = float(sys.argv[3])
json.dump(c, open(sys.argv[2], "w"), indent=1)
EOF
      names="$names s$s"; cfgs="$cfgs $OUT/configs/calib-$s.json"
    done
    stem=calib-$(date +%H%M%S)
    echo "$names" > "$OUT/cost/$stem.names"
    echo "=== calib start $(date '+%F %T') load: $(load)"
    "$BIN/p4_cost" tmp/d1/x1-l6a.moves.jsonl 150 2 "$OUT/cost/$stem.csv" $cfgs 2>/dev/null
    echo "=== calib done $(date '+%F %T') load: $(load)"
    python3 engine-rs/scripts/p4_cost_report.py "$OUT/cost/$stem.csv" $names | tee "$OUT/cost/$stem.md" ;;
  confirm)
    pin
    [ -f "$OUT/configs/S4T.json" ] || { echo "no $OUT/configs/S4T.json" >&2; exit 1; }
    cp $CFG/v5.0-p4i-ultra.json "$OUT/configs/base.json"
    echo "S4 confirm start $(date '+%F %T'): base S4T, $CSEEDS seeds from $CSEED_BASE"
    per=$(( THREADS / 2 ))
    for arm in base S4T; do
      block "$OUT/configs/$arm.json" "s4c-$arm" "$OUT/confirm" "$CSEEDS" "$CSEED_BASE" "$per" &
    done
    wait
    python3 engine-rs/scripts/s4_report.py --confirm "$OUT" | tee "$OUT/confirm.md"
    echo "S4 CONFIRM DONE $(date '+%F %T')" ;;
  reuse)
    pin
    g=${2:-48}
    # Stage 2: the X3 compute block's games of v5.0-p4i-ultra as saved against level 6 (200 seeds from
    # 86,300,000); the binary reproduces their searched moves exactly (checked per decision).
    src=tmp/x3/x3-c-et.moves.jsonl
    "$BIN/p67_probe" reuse "$src" $CFG/v5.0-p4i-ultra.json "$g" "$OUT/reuse/reuse.csv"
    python3 engine-rs/scripts/s4_report.py --reuse "$OUT/reuse/reuse.csv" 3115 | tee "$OUT/reuse/reuse.md" ;;
  *)
    echo "usage: $0 pin | identity | cost [N] | calib SCALE... | confirm | reuse [GAMES]" >&2
    exit 2 ;;
esac
