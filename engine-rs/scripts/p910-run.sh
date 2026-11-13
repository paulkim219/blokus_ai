#!/usr/bin/env bash
# P9/P10 (selection rule, P4 at interior nodes, opening rules): identity gates, a clean cost run, the
# tree shape of every arm, liveness, the 400-seed screen against three Pentobi level-6 seats, selection,
# confirmation (with combination and equal-time arms where the rule asks for them), the direct match.
# Preregistered 2026-11-13 in research_paper/v6_native_and_learning_preregistered.md ("P9/P10");
# results in research_paper/v5_p9_p10_selection_results.md.
#
#   engine-rs/scripts/p910-run.sh pin             # copy the binaries built from HEAD to tmp/p910/bin (once)
#   engine-rs/scripts/p910-run.sh before          # reference binaries: tmp/p67/bin (built from 79bfa0b)
#   engine-rs/scripts/p910-run.sh identity        # parity of every option at its identity point
#   engine-rs/scripts/p910-run.sh cost [N]        # ms/move, every arm, same positions; NOTHING ELSE RUNNING
#   engine-rs/scripts/p910-run.sh shape [N]       # tree shape of base and every arm on N X1 positions
#   engine-rs/scripts/p910-run.sh live            # liveness: 2 seeds from 85,900,000 per arm
#   nohup engine-rs/scripts/p910-run.sh chain > tmp/p910/chain.log 2>&1 &   # screen -> select -> confirm -> match
#   engine-rs/scripts/p910-run.sh match CONFIG    # a config vs three v5.0-p4-ultra seats
#   python3 engine-rs/scripts/p910_report.py tmp/p910 [--live|--confirm|--select|--cost|--shape]
#
# Match settings are P1-P3's: --mode one-blokee --level 6 --budget 300, Pentobi 31.0 with its Classic
# book, one Pentobi thread, seed = game seed, one seed = 4 games (the Blokee seat rotated).
# Screen: SEEDS=400 from 85,000,000, arms one after another on 10 threads. Confirmation: CSEEDS=400
# from 85,400,000, base and every confirmation arm started together. Direct match: 200 seeds from
# 85,800,000. Resumable: blokee-pentobi skips seed/seat pairs already in a JSONL. Sentinel lines:
# "P910 SCREEN DONE", "P910 CHAIN DONE". Run every chain under caffeinate -i -s -m -w <pid>.
set -u
cd "$(dirname "$0")/../.."

OUT=${OUT:-tmp/p910}
THREADS=${THREADS:-10}
SEEDS=${SEEDS:-400}
SEED_BASE=${SEED_BASE:-85000000}
CSEEDS=${CSEEDS:-400}
CSEED_BASE=${CSEED_BASE:-85400000}
MSEEDS=${MSEEDS:-200}
MSEED_BASE=${MSEED_BASE:-85800000}
LIVE_SEEDS=${LIVE_SEEDS:-2}
LIVE_BASE=${LIVE_BASE:-85900000}
PENTOBI=${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}
BOOK=${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}
ARMS_ALL="P10A P10B P4I P4IP10A P9A P9B O0"
OPEN_ARMS="P9A O0"   # arms that search the opening: also costed over own moves 0+
BASE_CFG=engine-rs/configs/v5.0-p4-ultra.json
BIN=$OUT/bin
BEFORE=$OUT/bin-before
SUMMARY=$OUT/summary.txt
load() { uptime | sed 's/.*load averages*: //'; }

mkdir -p "$OUT/live" "$OUT/screen" "$OUT/confirm" "$OUT/match" "$OUT/identity" "$OUT/cost" "$OUT/shape"
[ -f "$OUT/configs/manifest.json" ] || python3 engine-rs/scripts/p910_configs.py "$OUT/configs" > "$OUT/configs.log" || { cat "$OUT/configs.log"; exit 1; }

pin() {
  if [ ! -x "$BIN/blokee-pentobi" ]; then
    [ -z "$(git status --short engine-rs/src engine-rs/Cargo.toml engine-rs/examples)" ] || { echo "engine sources not committed; refusing to pin" >&2; exit 1; }
    mkdir -p "$BIN"
    cp engine-rs/target/release/blokee-pentobi engine-rs/target/release/blokee-match engine-rs/target/release/blokee-selfplay "$BIN/"
    cp engine-rs/target/release/examples/p4_cost engine-rs/target/release/examples/p910_probe "$BIN/"
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
  play "$OUT/configs/p910-$arm.json" "$label" "$dir/$label.jsonl" "$seeds" "$base" "$threads" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|wrote|rror" || true
  echo "=== $label done $(date '+%F %T') load: $(load)"
  {
    echo "=== $label ($(date '+%F %T'), load $(load))"
    [ -f "$dir/$label.failures.jsonl" ] && echo "HARD FAILURES: $(wc -l < "$dir/$label.failures.jsonl")"
    npx tsx scripts/aggregateMatches.ts "$dir/$label.jsonl"
    echo
  } >> "$SUMMARY" 2>&1
}

cost_run() {  # cost_run <stem> <positions> <arm>...   (base is always config 0)
  local stem=$1 n=$2; shift 2
  local names="base $*" cfgs=""
  for a in $names; do cfgs="$cfgs $OUT/configs/p910-$a.json"; done
  echo "$names" > "$OUT/cost/$stem.names"
  echo "=== cost $stem start $(date '+%F %T') load: $(load)"
  "$BIN/p4_cost" tmp/d1/x1-l6a.moves.jsonl "$n" 2 "$OUT/cost/$stem.csv" $cfgs
  echo "=== cost $stem done $(date '+%F %T') load: $(load)"
  python3 engine-rs/scripts/p4_cost_report.py "$OUT/cost/$stem.csv" $names | tee "$OUT/cost/$stem.md"
}

case "${1:-}" in
  pin)
    pin; cat "$BIN/PROVENANCE.txt" ;;
  before)
    # Engine sources (engine-rs/src, Cargo.*) are identical between 79bfa0b (where tmp/p67/bin was
    # built) and 54b1a5f, this change's parent; those binaries are the pre-change reference.
    mkdir -p "$BEFORE"
    [ -z "$(git diff --stat 79bfa0b 54b1a5f -- engine-rs/src engine-rs/Cargo.toml engine-rs/Cargo.lock)" ] || { echo "engine changed after 79bfa0b" >&2; exit 1; }
    cp tmp/p67/bin/blokee-match tmp/p67/bin/blokee-pentobi tmp/p67/bin/blokee-selfplay "$BEFORE/"
    { date '+%F %T'; echo "copied from tmp/p67/bin (built at 79bfa0b; engine sources equal at 54b1a5f)"; shasum -a 256 "$BEFORE"/blokee-*; } > "$BEFORE/PROVENANCE.txt"
    cat "$BEFORE/PROVENANCE.txt" ;;
  identity)
    pin
    I=$OUT/identity
    C=$BASE_CFG
    echo "=== identity start $(date '+%F %T') load: $(load)"
    rm -f "$I"/mirror-*.jsonl
    "$BIN/blokee-match" --challenger $C --champion $C --seeds 20 --seed-base 80900000 --budget 300 --threads "$THREADS" \
      --label mirror-p4u --out "$I/mirror-p4u.jsonl" 2>&1 | tail -1
    "$BIN/blokee-match" --challenger "$OUT/configs/p910-ID.json" --champion $C --seeds 20 --seed-base 80900000 --budget 300 --threads "$THREADS" \
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
    rm -rf "$I"/sp-*
    "$BEFORE/blokee-selfplay" --config $C --games 6 --budget 300 --threads 1 --seed-base 80950000 --out "$I/sp-before" 2>/dev/null
    "$BIN/blokee-selfplay" --config $C --games 6 --budget 300 --threads 1 --seed-base 80950000 --out "$I/sp-after" 2>/dev/null
    "$BIN/blokee-selfplay" --config "$OUT/configs/p910-ID.json" --games 6 --budget 300 --threads 1 --seed-base 80950000 --out "$I/sp-ID" 2>/dev/null
    for d in sp-after sp-ID; do
      if cmp -s "$I/sp-before/shard-00.bin" "$I/$d/shard-00.bin" && cmp -s "$I/sp-before/games.jsonl" "$I/$d/games.jsonl"; then
        echo "self-play $d: shard-00.bin and games.jsonl byte-identical to the old binary ($(wc -c < "$I/$d/shard-00.bin") bytes, $(wc -l < "$I/$d/games.jsonl") games)"
      else
        echo "self-play $d: DIFFERS from the old binary"
      fi
    done
    shasum -a 256 "$I"/sp-*/shard-00.bin "$I"/sp-*/games.jsonl
    rm -f "$I"/br-*
    for pair in "before:$BEFORE/blokee-pentobi:$C" "after:$BIN/blokee-pentobi:$C" "ID:$BIN/blokee-pentobi:$OUT/configs/p910-ID.json"; do
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
    cost_run cost "${2:-150}" ID $ARMS_ALL
    # Arms that search the opening: ms/move over own moves 0+ (base plays 0-2 from the heuristic).
    ( export P4_COST_MIN_OWN=0; cost_run cost-open "${2:-150}" $OPEN_ARMS ) ;;
  shape)
    pin
    n=${2:-48}
    cfgs=""; for a in base $ARMS_ALL; do cfgs="$cfgs $OUT/configs/p910-$a.json"; done
    "$BIN/p910_probe" shape tmp/d1/x1-l6a.moves.jsonl "$n" "$OUT/shape/arms.csv" $cfgs
    python3 engine-rs/scripts/p910_report.py --shape tmp/p910/diag/shape-pentobi.csv "$OUT/shape/arms.csv" | tee "$OUT/shape/arms.md" ;;
  live)
    pin
    echo "$ARMS_ALL" > "$OUT/ARMS_LIVE"
    for arm in base $ARMS_ALL; do
      echo "=== live $arm ($(date '+%F %T'), load $(load))"
      play "$OUT/configs/p910-$arm.json" "p910-live-$arm" "$OUT/live/p910-live-$arm.jsonl" "$LIVE_SEEDS" "$LIVE_BASE" "$THREADS" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|wrote|rror" || true
    done
    python3 engine-rs/scripts/p910_report.py "$OUT" --live | tee "$OUT/live.md" ;;
  chain)
    pin
    [ -f "$OUT/ARMS" ] || { echo "no $OUT/ARMS: fix the arms before the screen" >&2; exit 1; }
    arms=$(cat "$OUT/ARMS")
    echo "P910 chain start $(date '+%F %T'); screen arms: $arms; threads $THREADS"
    for arm in base $arms; do
      block "$arm" "$OUT/screen" p910s "$SEEDS" "$SEED_BASE" "$THREADS"
    done
    echo "P910 SCREEN DONE $(date '+%F %T')"
    python3 engine-rs/scripts/p910_report.py "$OUT" > "$OUT/screen.md"
    cat "$OUT/screen.md"
    python3 engine-rs/scripts/p910_report.py "$OUT" --select > "$OUT/selected.txt" 2> "$OUT/selection.log"
    cat "$OUT/selection.log"
    if [ -s "$OUT/selected.txt" ]; then
      cargs="base"
      newcost=""
      while read -r first name rest; do
        if [ "$first" = COMBO ]; then
          python3 engine-rs/scripts/p910_configs.py "$OUT/configs" --combo "$name" $rest >> "$OUT/configs.log"
          cargs="$cargs $name"; newcost="$newcost $name"
        else
          cargs="$cargs $first"
        fi
      done < "$OUT/selected.txt"
      # Arms first built here are costed now, on the idle machine, before any confirmation game.
      [ -z "$newcost" ] || cost_run cost-confirm 150 $newcost
      [ -z "$newcost" ] || ( export P4_COST_MIN_OWN=0; cost_run cost-open-confirm 150 $newcost )
      for arm in $cargs; do
        [ "$arm" = base ] && continue
        ratio=$(python3 engine-rs/scripts/p910_report.py "$OUT" --cost-ratio "$arm")
        if python3 -c "import sys; sys.exit(0 if float('$ratio') > 1.25 else 1)"; then
          parts=$(grep "^COMBO $arm " "$OUT/selected.txt" | cut -d' ' -f3-)
          if [ -n "$parts" ]; then
            python3 engine-rs/scripts/p910_configs.py "$OUT/configs" --combo "$arm" $parts --equal-time "$arm" "$ratio" >> "$OUT/configs.log"
          else
            python3 engine-rs/scripts/p910_configs.py "$OUT/configs" --equal-time "$arm" "$ratio" >> "$OUT/configs.log"
          fi
          cargs="$cargs $arm-ET"
        fi
      done
      echo "P910 confirmation start $(date '+%F %T'): $cargs"
      echo "$cargs" > "$OUT/CONFIRM_ARMS"
      n=$(echo $cargs | wc -w | tr -d ' ')
      per=$(( THREADS / n )); [ "$per" -ge 1 ] || per=1
      for arm in $cargs; do
        block "$arm" "$OUT/confirm" p910c "$CSEEDS" "$CSEED_BASE" "$per" &
      done
      wait
      python3 engine-rs/scripts/p910_report.py "$OUT" --confirm > "$OUT/confirm.md"
      cat "$OUT/confirm.md"
      winner=$(sed -n 's/^NEW BASE: //p' "$OUT/confirm.md")
      if [ -n "$winner" ] && [ "$winner" != "(none)" ]; then
        echo "P910 direct match start $(date '+%F %T'): $winner vs three v5.0-p4-ultra"
        "$BIN/blokee-match" --challenger "$OUT/configs/p910-$winner.json" --champion $BASE_CFG --seeds "$MSEEDS" --seed-base "$MSEED_BASE" --budget 300 \
          --threads "$THREADS" --label "match-p910-$winner" --out "$OUT/match/match-p910-$winner.jsonl" 2>&1 | tail -1
        npx tsx scripts/aggregateMatches.ts "$OUT/match/match-p910-$winner.jsonl" | tee "$OUT/match/match-p910-$winner.txt"
      fi
    else
      echo "No arm cleared the screen (paired CI lower bound > 0); no confirmation run, as preregistered." > "$OUT/confirm.md"
      cat "$OUT/confirm.md"
    fi
    echo "P910 CHAIN DONE $(date '+%F %T')" ;;
  match)
    pin
    cfg=${2:?config}
    name=$(basename "$cfg" .json)
    echo "=== match $name start $(date '+%F %T') load: $(load)"
    "$BIN/blokee-match" --challenger "$cfg" --champion $BASE_CFG --seeds "$MSEEDS" --seed-base "$MSEED_BASE" --budget 300 \
      --threads "$THREADS" --label "match-$name" --out "$OUT/match/match-$name.jsonl" 2>&1 | tail -1
    npx tsx scripts/aggregateMatches.ts "$OUT/match/match-$name.jsonl" | tee "$OUT/match/match-$name.txt"
    echo "P910 MATCH DONE $(date '+%F %T')" ;;
  *)
    echo "usage: $0 pin | before | identity | cost [N] | shape [N] | live | chain | match CONFIG   (arms: $ARMS_ALL)" >&2
    exit 2 ;;
esac
