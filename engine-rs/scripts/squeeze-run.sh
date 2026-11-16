#!/usr/bin/env bash
# Squeeze benchmark runner (docs/SQUEEZE_BENCHMARK.md, docs/SQUEEZE_RUNBOOK.md).
#
#   engine-rs/scripts/squeeze-run.sh smoke              # 8 games, compares with the Mac's reference
#   engine-rs/scripts/squeeze-run.sh S1                 # adversary arm screen at the level-6 budget
#   engine-rs/scripts/squeeze-run.sh S2 <ARM>           # budgets l6 / l6x4 / pro for the chosen arm
#   engine-rs/scripts/squeeze-run.sh freeze <ARM> <BUDGET>   # writes configs/squeeze-v1*.json
#   engine-rs/scripts/squeeze-run.sh S3                 # the benchmark itself, with squeeze-v1
#
# Run from the repo root. Environment: THREADS (default: cores - 2), PENTOBI (pentobi-gtp binary),
# BOOK (Pentobi's book_classic.blksgf). Results go to research_paper/squeeze_runs/<stage>/, one JSONL
# per (adversary, target), named <adversary>__<target>.jsonl. A finished file (all games present) is
# skipped on a re-run; an unfinished one is deleted and played again, so a stage can be restarted.
set -euo pipefail

STAGE="${1:?stage: smoke | S1 | S2 <ARM> | freeze <ARM> <BUDGET> | S3}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
CORES="$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
THREADS="${THREADS:-$((CORES > 3 ? CORES - 2 : 1))}"
PENTOBI="${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}"
BOOK="${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}"
BIN="$ROOT/engine-rs/target/release"
OUT="$ROOT/research_paper/squeeze_runs"
CFG="engine-rs/configs"

# Seed blocks, fixed in docs/SQUEEZE_BENCHMARK.md before the first game.
S1_SEEDS=110000000; S2_SEEDS=110100000; S3_SEEDS=110200000
DEV_N=25; SCORE_N=100

# The development panel: four of our tiers and four Pentobi levels, each weighed equally.
BLOKEE_TARGETS=(v5.2-nano v5.2-lite v5.2 v5.2-pro)
PENTOBI_TARGETS=(1 3 5 7)

need_build() {
  if [ ! -x "$BIN/blokee-match" ] || [ ! -x "$BIN/blokee-pentobi" ]; then
    (cd engine-rs && cargo build --release)
  fi
}

complete() { # file expected-lines
  [ -f "$1" ] && [ "$(grep -c . "$1")" -ge "$2" ]
}

# One (adversary, target) cell: target is a Blokee config name or "L<level>" for Pentobi.
cell() { # dir adversary-config target seeds seed-base [extra flags…]
  local dir="$1" adv="$2" target="$3" n="$4" base="$5"; shift 5
  local advname; advname="$(basename "$adv" .json)"
  local file="$dir/${advname}__${target}.jsonl"
  mkdir -p "$dir"
  if complete "$file" $((n * 4)); then echo "skip $file (complete)"; return; fi
  rm -f "$file"
  echo "=== ${advname} vs ${target}: $n seeds from $base, $THREADS threads, $(date '+%F %T')"
  if [[ "$target" == L* ]]; then
    "$BIN/blokee-pentobi" --squeeze --mode one-pentobi --gtp-processes per-seat \
      --blokee "$adv" --pentobi "$PENTOBI" --book "$BOOK" --level "${target#L}" \
      --budget 300 --threads "$THREADS" --seeds "$n" --seed-base "$base" \
      --label "${advname}__${target}" --out "$file" "$@" 2>&1 | grep -E "panic|HARD|rror|wall ms" || true
  else
    "$BIN/blokee-match" --squeeze --challenger "$CFG/$target.json" --champion "$adv" \
      --budget 300 --threads "$THREADS" --seeds "$n" --seed-base "$base" \
      --label "${advname}__${target}" --out "$file" "$@" 2>&1 | grep -E "panic|rror|challenger:" || true
  fi
  complete "$file" $((n * 4)) || { echo "INCOMPLETE: $file"; exit 1; }
}

# The same pairing without the squeeze: the target against three ordinary seats (validity check 1).
ordinary() { # dir ordinary-config target seeds seed-base
  local dir="$1" ord="$2" target="$3" n="$4" base="$5"
  local file="$dir/ordinary__${target}.jsonl"
  mkdir -p "$dir"
  if complete "$file" $((n * 4)); then echo "skip $file (complete)"; return; fi
  rm -f "$file"
  echo "=== ordinary vs ${target}: $n seeds from $base, $(date '+%F %T')"
  if [[ "$target" == L* ]]; then
    "$BIN/blokee-pentobi" --mode one-pentobi --gtp-processes per-seat \
      --blokee "$ord" --pentobi "$PENTOBI" --book "$BOOK" --level "${target#L}" \
      --budget 300 --threads "$THREADS" --seeds "$n" --seed-base "$base" \
      --label "ordinary__${target}" --out "$file" 2>&1 | grep -E "panic|HARD|rror|wall ms" || true
  else
    "$BIN/blokee-match" --challenger "$CFG/$target.json" --champion "$ord" \
      --budget 300 --threads "$THREADS" --seeds "$n" --seed-base "$base" \
      --label "ordinary__${target}" --out "$file" 2>&1 | grep -E "panic|rror" || true
  fi
  complete "$file" $((n * 4)) || { echo "INCOMPLETE: $file"; exit 1; }
}

panel() { # dir adversary-config seeds seed-base
  for t in "${BLOKEE_TARGETS[@]}"; do cell "$1" "$2" "$t" "$3" "$4"; done
  for l in "${PENTOBI_TARGETS[@]}"; do cell "$1" "$2" "L$l" "$3" "$4"; done
}

need_build
case "$STAGE" in
  smoke)
    dir="$OUT/smoke-$(hostname -s)"
    rm -rf "$dir"
    cell "$dir" "$CFG/squeeze/SQ0-l6.json" v5.2-nano 2 6000
    cell "$dir" "$CFG/squeeze/SQ0-l6.json" L1 1 6000
    python3 engine-rs/scripts/squeeze_report.py --compare "$OUT/smoke-reference" "$dir"
    ;;
  S1)
    for arm in SQ0 SQR SQP SQRP; do panel "$OUT/S1" "$CFG/squeeze/$arm-l6.json" "$DEV_N" "$S1_SEEDS"; done
    python3 engine-rs/scripts/squeeze_report.py --select-arm "$OUT/S1" | tee "$OUT/S1/selection.md"
    ;;
  S2)
    arm="${2:?S2 needs the arm chosen in S1 (see research_paper/squeeze_runs/S1/selection.md)}"
    for budget in l6 l6x4 pro; do panel "$OUT/S2" "$CFG/squeeze/$arm-$budget.json" "$DEV_N" "$S2_SEEDS"; done
    python3 engine-rs/scripts/squeeze_report.py --select-budget "$OUT/S2" "$arm" | tee "$OUT/S2/selection.md"
    ;;
  freeze)
    arm="${2:?freeze <ARM> <BUDGET>}"; budget="${3:?freeze <ARM> <BUDGET>}"
    python3 - "$arm" "$budget" <<'EOF'
import json, sys
arm, budget = sys.argv[1], sys.argv[2]
adv = json.load(open(f"engine-rs/configs/squeeze/{arm}-{budget}.json"))
json.dump(adv, open("engine-rs/configs/squeeze-v1.json", "w"), indent=1)
# The ordinary opponents for validity check 1: v5.2-pro's settings at the adversary's budget.
ordinary = json.load(open("engine-rs/configs/v5.2-pro.json"))
ordinary["search"]["iterationScale"] = adv["search"]["iterationScale"]
json.dump(ordinary, open("engine-rs/configs/squeeze-v1-ordinary.json", "w"), indent=1)
print(f"squeeze-v1 = {arm}-{budget} (iterationScale {adv['search']['iterationScale']}); ordinary at the same budget")
EOF
    ;;
  S3)
    [ -f "$CFG/squeeze-v1.json" ] || { echo "run freeze first"; exit 1; }
    dir="$OUT/S3"
    for t in v5.2-nano v5.2-lite v5.2 v5.2-l6 v5.2-pro; do cell "$dir" "$CFG/squeeze-v1.json" "$t" "$SCORE_N" "$S3_SEEDS"; done
    for l in 1 2 3 4 5 6 7; do cell "$dir" "$CFG/squeeze-v1.json" "L$l" "$SCORE_N" "$S3_SEEDS"; done
    # Validity check 1, on the same seeds: v5.2 and Pentobi level 5 against three ordinary seats.
    ordinary "$dir" "$CFG/squeeze-v1-ordinary.json" v5.2 "$SCORE_N" "$S3_SEEDS"
    ordinary "$dir" "$CFG/squeeze-v1-ordinary.json" L5 "$SCORE_N" "$S3_SEEDS"
    python3 engine-rs/scripts/squeeze_report.py --score "$dir" | tee "$dir/scores.md"
    ;;
  *) echo "unknown stage $STAGE"; exit 1 ;;
esac
echo "stage $STAGE done $(date '+%F %T')"
