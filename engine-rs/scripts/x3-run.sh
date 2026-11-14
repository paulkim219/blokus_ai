#!/usr/bin/env bash
# X3: where engine-rs/configs/v5.0-p4i-ultra.json stands against Pentobi 31.0 (descriptive, no gate).
# Design: research_paper/v6_native_and_learning_preregistered.md, entry "X3" of 2026-11-13.
# Results: research_paper/v5_x3_p4i_benchmark_results.md. Same structure as x2-run.sh.
#
#   engine-rs/scripts/x3-run.sh pin        # build blokee-pentobi from HEAD, copy to tmp/x3/bin (once)
#   engine-rs/scripts/x3-run.sh identity   # pinned binary vs tmp/p910/bin on 3 seeds (86,900,000-002)
#   nohup engine-rs/scripts/x3-run.sh chain > tmp/x3/chain.log 2>&1 &    # every arm, one after another
#   python3 engine-rs/scripts/x3_report.py tmp/x3
#
# Every arm: budget 300, Pentobi 31.0 with its Classic book, one Pentobi thread, seed = game seed, one
# seed = 4 games (the lone seat rotated), THREADS game threads, arms strictly one after another so each
# arm's ms/move comes from a run with no other job of ours overlapping. Resumable (blokee-pentobi skips
# seed/seat pairs already in a JSONL). Sentinels: "X3 ARM <label> DONE", "X3 CHAIN DONE".
# Run the chain under caffeinate -i -s -m -w <chain pid>.
set -u
cd "$(dirname "$0")/../.."
export PATH=$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$HOME/.cargo/bin:$PATH

OUT=${OUT:-tmp/x3}
THREADS=${THREADS:-10}
PENTOBI=${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}
BOOK=${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}
P4I=engine-rs/configs/v5.0-p4i-ultra.json
P4=engine-rs/configs/v5.0-p4-ultra.json
BIN=$OUT/bin/blokee-pentobi
REF=tmp/p910/bin/blokee-pentobi
load() { uptime | sed 's/.*load averages*: //'; }

mkdir -p "$OUT/bin" "$OUT/configs" "$OUT/identity"

# Compute arms: the saved config with search.iterationScale 16 (equal iterations) and 32.
for s in 16 32; do
  [ -f "$OUT/configs/v5.0-p4i-ultra-is$s.json" ] || python3 - "$P4I" "$OUT/configs/v5.0-p4i-ultra-is$s.json" "$s" <<'EOF'
import json, sys
c = json.load(open(sys.argv[1]))
c["search"]["iterationScale"] = float(sys.argv[3])
json.dump(c, open(sys.argv[2], "w"), indent=1)
EOF
done

run() {  # run <label> <config> <mode> <level> <seeds> <seed-base>
  local label=$1 cfg=$2 mode=$3 level=$4 seeds=$5 base=$6
  echo "=== $label start $(date '+%F %T') load: $(load)"
  printf '%s\tstart\t%s\t%s\n' "$label" "$(date '+%F %T')" "$(load)" >> "$OUT/arms.tsv"
  "$BIN" --blokee "$cfg" --blokee-name "$(basename "$cfg" .json)" --pentobi "$PENTOBI" --book "$BOOK" \
    --mode "$mode" --level "$level" --budget 300 --threads "$THREADS" \
    --seeds "$seeds" --seed-base "$base" --label "$label" --out "$OUT/$label.jsonl" \
    --moves-out "$OUT/$label.moves.jsonl" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|wrote|rror" || true
  printf '%s\tend\t%s\t%s\n' "$label" "$(date '+%F %T')" "$(load)" >> "$OUT/arms.tsv"
  {
    echo "=== $label ($(date '+%F %T'), load $(load))"
    [ -f "$OUT/$label.failures.jsonl" ] && echo "HARD FAILURES: $(wc -l < "$OUT/$label.failures.jsonl")"
    npx tsx scripts/aggregateMatches.ts "$OUT/$label.jsonl"
    echo
  } >> "$OUT/summary.txt" 2>&1
  python3 engine-rs/scripts/x3_report.py "$OUT" > "$OUT/report.md" 2>&1
  echo "X3 ARM $label DONE $(date '+%F %T') load: $(load)"
}

case "${1:-}" in
  pin)
    if [ ! -x "$BIN" ]; then
      [ -z "$(git status --short engine-rs/src engine-rs/Cargo.toml engine-rs/Cargo.lock)" ] || { echo "engine sources not committed; refusing to pin" >&2; exit 1; }
      (cd engine-rs && cargo build --release --bin blokee-pentobi) || exit 1
      cp engine-rs/target/release/blokee-pentobi "$BIN"
      { date '+%F %T'; echo "HEAD $(git rev-parse HEAD)"; echo "built from HEAD with cargo build --release --bin blokee-pentobi";
        git status --short; shasum -a 256 "$BIN" "$REF"; } > "$OUT/bin/PROVENANCE.txt"
    fi
    cat "$OUT/bin/PROVENANCE.txt" ;;
  identity)
    # Same config, seeds, level and threads through both binaries; every game's moves and scores must match.
    for cfg in "$P4" "$P4I"; do
      name=$(basename "$cfg" .json)
      for b in x3 ref; do
        bin=$BIN; [ $b = ref ] && bin=$REF
        f="$OUT/identity/id-$b-$name"
        rm -f "$f".jsonl "$f".moves.jsonl "$f".timing.jsonl
        "$bin" --blokee "$cfg" --blokee-name "$name" --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --level 6 \
          --budget 300 --threads 6 --seeds 3 --seed-base 86900000 --label "id-$name" --out "$f.jsonl" \
          --moves-out "$f.moves.jsonl" 2>&1 | tr '\r' '\n' | grep -E "panic|HARD|rror" || true
      done
      python3 - "$OUT/identity/id-x3-$name" "$OUT/identity/id-ref-$name" "$name" <<'EOF'
import json, sys
def rd(p):
    return {(g["seed"], g["seat"]): (g["moves"], g["scores"]) for g in map(json.loads, open(p + ".moves.jsonl")) }
a, b = rd(sys.argv[1]), rd(sys.argv[2])
same = sum(a[k] == b[k] for k in a if k in b)
print(f"{sys.argv[3]}: {same}/{len(a)} games move-for-move and score equal (ref has {len(b)})")
EOF
    done | tee "$OUT/identity.log" ;;
  chain)
    echo "X3 chain start $(date '+%F %T') pid $$ load: $(load)"
    run x3-l5-p4i  "$P4I" one-blokee  5 200 86000000
    run x3-l5-p4   "$P4"  one-blokee  5 200 86000000
    run x3-rev     "$P4I" one-pentobi 6 200 86200000
    run x3-c-et    "$P4I" one-blokee  6 200 86300000
    run x3-c-is16  "$OUT/configs/v5.0-p4i-ultra-is16.json" one-blokee 6 200 86300000
    run x3-c-is32  "$OUT/configs/v5.0-p4i-ultra-is32.json" one-blokee 6 200 86300000
    run x3-l7-p4i  "$P4I" one-blokee  7 200 86100000
    run x3-l7-p4   "$P4"  one-blokee  7 200 86100000
    echo "X3 CHAIN DONE $(date '+%F %T')" ;;
  *) echo "usage: $0 pin|identity|chain" >&2; exit 2 ;;
esac
