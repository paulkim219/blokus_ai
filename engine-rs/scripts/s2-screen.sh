#!/usr/bin/env bash
# S2: config-only screen of single-change `v5.0-p4-ultra` variants against three Pentobi level-6
# seats, then confirmation of what clears it. Preregistered 2026-11-13 04:55 CST in
# research_paper/v6_native_and_learning_preregistered.md ("S2"); results in
# research_paper/v5_s2_config_screen_results.md.
#
#   engine-rs/scripts/s2-screen.sh pin                 # copy the pinned P4 binary to tmp/s2/bin (once)
#   engine-rs/scripts/s2-screen.sh live                # liveness: 2 seeds from 82,900,000 per arm
#   nohup engine-rs/scripts/s2-screen.sh chain > tmp/s2/chain.log 2>&1 &   # screen -> select -> confirm
#   engine-rs/scripts/s2-screen.sh run [ARM ...]       # screen only (base always first)
#   engine-rs/scripts/s2-screen.sh confirm ARM ...     # confirmation of these arms (+ base)
#   python3 engine-rs/scripts/s2_report.py tmp/s2 [--live|--confirm|--select]
#
# Arms: engine-rs/scripts/s2_configs.py writes every candidate config; the screened arms are the
# ones listed in $OUT/ARMS (fixed in $OUT/ARMS-FIXED.md after liveness, before the first screen
# game). Match settings are S1's: --mode one-blokee --level 6 --budget 300, Pentobi 31.0 with its
# Classic book, one Pentobi thread, seed = game seed, one seed = 4 games. Screen: SEEDS=100 from
# SEED_BASE=82,000,000. Confirmation: CSEEDS=200 from CSEED_BASE=82,100,000. Resumable:
# blokee-pentobi skips seed/seat pairs already in a JSONL.
set -u
cd "$(dirname "$0")/../.."

OUT=${OUT:-tmp/s2}
THREADS=${THREADS:-6}
SEEDS=${SEEDS:-100}
SEED_BASE=${SEED_BASE:-82000000}
CSEEDS=${CSEEDS:-200}
CSEED_BASE=${CSEED_BASE:-82100000}
LIVE_SEEDS=${LIVE_SEEDS:-2}
LIVE_BASE=${LIVE_BASE:-82900000}
PENTOBI=${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}
BOOK=${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}
PINNED=${PINNED:-tmp/p4/bin/blokee-pentobi}
ARMS_CANDIDATE="C08 C32 O0 IV1 SHAPE N96 E30"
RESULTS=research_paper/v5_s2_config_screen_results.md
BIN=$OUT/bin/blokee-pentobi
SUMMARY=$OUT/summary.txt
load() { uptime | sed 's/.*load averages*: //'; }

mkdir -p "$OUT/bin" "$OUT/live" "$OUT/screen" "$OUT/confirm"
python3 engine-rs/scripts/s2_configs.py "$OUT/configs" > "$OUT/configs.log" || { cat "$OUT/configs.log"; exit 1; }

pin() {
  if [ ! -x "$BIN" ]; then
    cp "$PINNED" "$BIN"
    {
      echo "copied $(date '+%F %T') from $PINNED (the P4/P5 pinned binary; see tmp/p4/bin/PROVENANCE.txt)"
      shasum -a 256 "$BIN"
      echo "--- tmp/p4/bin/PROVENANCE.txt:"
      cat "$(dirname "$PINNED")/PROVENANCE.txt"
    } > "$OUT/bin/PROVENANCE.txt"
  fi
}

play() {  # play <arm> <label> <out.jsonl> <seeds> <seed-base>
  local arm=$1 label=$2 out=$3 seeds=$4 base=$5
  "$BIN" --blokee "$OUT/configs/s2-$arm.json" --pentobi "$PENTOBI" --book "$BOOK" \
    --mode one-blokee --level 6 --budget 300 --threads "$THREADS" \
    --seeds "$seeds" --seed-base "$base" --label "$label" --out "$out" \
    --moves-out "${out%.jsonl}.moves.jsonl"
}

block() {  # block <arm> <dir> <prefix> <seeds> <seed-base>
  local arm=$1 dir=$2 prefix=$3 seeds=$4 base=$5
  local label="$prefix-$arm"
  echo "=== $label start $(date '+%F %T') load: $(load)"
  play "$arm" "$label" "$dir/$label.jsonl" "$seeds" "$base" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|wrote|rror" || true
  echo "=== $label done $(date '+%F %T') load: $(load)"
  {
    echo "=== $label ($(date '+%F %T'), load $(load))"
    [ -f "$dir/$label.failures.jsonl" ] && echo "HARD FAILURES: $(wc -l < "$dir/$label.failures.jsonl")"
    npx tsx scripts/aggregateMatches.ts "$dir/$label.jsonl"
    echo
  } >> "$SUMMARY" 2>&1
}

fixed_arms() {
  [ -f "$OUT/ARMS" ] || { echo "no $OUT/ARMS: fix the arms (ARMS-FIXED.md) before the screen" >&2; exit 1; }
  cat "$OUT/ARMS"
}

fill() {  # fill <TAG> <file>: replace the block between <!-- S2:TAG --> and <!-- /S2:TAG --> in the results file
  python3 - "$RESULTS" "$1" "$2" <<'EOF'
import re, sys
path, tag, src = sys.argv[1:]
text, body = open(path).read(), open(src).read().rstrip("\n")
pat = re.compile(rf"(<!-- S2:{tag} -->\n).*?(\n<!-- /S2:{tag} -->)", re.S)
if pat.search(text):
    open(path, "w").write(pat.sub(lambda m: m.group(1) + body + m.group(2), text))
EOF
}

screen() {
  for arm in base "$@"; do
    block "$arm" "$OUT/screen" s2s "$SEEDS" "$SEED_BASE"
  done
}

confirm() {
  for arm in base "$@"; do
    block "$arm" "$OUT/confirm" s2c "$CSEEDS" "$CSEED_BASE"
  done
}

case "${1:-}" in
  pin)
    pin; cat "$OUT/bin/PROVENANCE.txt" ;;
  live)
    pin
    for arm in base $ARMS_CANDIDATE; do
      echo "=== live $arm ($(date '+%F %T'), load $(load))"
      play "$arm" "s2-live-$arm" "$OUT/live/s2-live-$arm.jsonl" "$LIVE_SEEDS" "$LIVE_BASE" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|wrote|rror" || true
    done
    python3 - "$OUT" $ARMS_CANDIDATE <<'EOF' | tee "$OUT/live.md"
import json, os, sys
root, arms = sys.argv[1], sys.argv[2:]
def moves(a):
    p = os.path.join(root, "live", f"s2-live-{a}.moves.jsonl")
    return {(m["seed"], m["seat"]): m["moves"] for m in map(json.loads, open(p))} if os.path.exists(p) else {}
b = moves("base")
print("| Arm | Games | Games ≠ base |\n|---|---:|---:|")
for a in arms:
    m = moves(a); common = [k for k in m if k in b]
    print(f"| {a} | {len(m)} | {sum(m[k] != b[k] for k in common)}/{len(common)} |")
EOF
    ;;
  run)
    pin; shift
    arms=${*:-$(fixed_arms)}
    screen $(echo "$arms" | tr ' ' '\n' | grep -vx base)
    echo "screen queue done: $SUMMARY" ;;
  confirm)
    pin; shift
    [ $# -gt 0 ] || { echo "confirm needs arms" >&2; exit 2; }
    confirm "$@"
    python3 engine-rs/scripts/s2_report.py "$OUT" --confirm > "$OUT/confirm.md"
    cat "$OUT/confirm.md"
    echo "confirmation done" ;;
  chain)
    pin
    arms=$(fixed_arms)
    echo "S2 chain start $(date '+%F %T'); screen arms: $arms; threads $THREADS"
    screen $arms
    python3 engine-rs/scripts/s2_report.py "$OUT" > "$OUT/screen.md"
    cat "$OUT/screen.md"
    fill SCREEN "$OUT/screen.md"
    python3 engine-rs/scripts/s2_report.py "$OUT" --select > "$OUT/selected.txt" 2> "$OUT/selection.log"
    cat "$OUT/selection.log"
    fill SELECTION "$OUT/selection.log"
    sel=$(cat "$OUT/selected.txt")
    if [ -n "$sel" ]; then
      echo "S2 confirmation start $(date '+%F %T'): $sel"
      confirm $sel
      python3 engine-rs/scripts/s2_report.py "$OUT" --confirm > "$OUT/confirm.md"
    else
      echo "No arm cleared the screen (paired CI lower bound > 0); no confirmation run, as preregistered." > "$OUT/confirm.md"
    fi
    cat "$OUT/confirm.md"
    fill CONFIRM "$OUT/confirm.md"
    echo "S2 chain done $(date '+%F %T')" ;;
  *)
    echo "usage: $0 pin | live | run [ARM ...] | confirm ARM ... | chain   (candidate arms: $ARMS_CANDIDATE)" >&2
    exit 2 ;;
esac
