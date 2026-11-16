#!/usr/bin/env bash
# Round 8 driver (preregistered 2026-11-16, "round 8" entry). Binary tmp/v55/bin-w1 (engine f2c01ee).
# Per tier ROOT = tmp/v55/W/<tier>: configs/, COSTS (clean cost, measured before the prereg), PLAYED,
# screen/rol-<arm>.jsonl, selected.txt, confirm/rolc-<arm>.jsonl. Sentinels "R8 <TIER> SCREEN DONE",
# "R8 <TIER> CONFIRM DONE", "R8 DONE". No block starts at or after 19:15.
set -u
cd "$(dirname "$0")/../.."
BIN=tmp/v55/bin-w1; G=engine-rs/configs; TH=12
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
ok() { h=$(date +%H%M); [ "$h" -lt 1915 ] && [ "$h" -ge 0900 ]; }
bp() {
  local cfg=$1 out=$2 lvl=$3 n=$4 sb=$5
  ok || { echo "=== $(basename $out .jsonl) NOT STARTED (19:15)"; return 1; }
  echo "=== $(basename $out .jsonl) start $(date '+%F %T')"
  "$BIN/blokee-pentobi" --blokee "$cfg" --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --gtp-processes per-seat \
    --level "$lvl" --budget 300 --threads "$TH" --seeds "$n" --seed-base "$sb" --label "$(basename $out .jsonl)" \
    --out "$out" --moves-out "${out%.jsonl}.moves.jsonl" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|rror" || true
  echo "=== $(basename $out .jsonl) done $(date '+%F %T')"
}
played() {  # arms as played: re-timed (-ET) when the clean cost is outside [0.97, 1.03]
  local D=$1 p=""
  for a in $(cat $D/ARMS); do
    c=$(python3 -c "import json; print(json.load(open('$D/COSTS'))['$a'])")
    if python3 -c "import sys; sys.exit(0 if 0.97 <= float('$c') <= 1.03 else 1)"; then p="$p $a"; else
      python3 engine-rs/scripts/v55_configs.py retime $D $a "$c" > /dev/null; p="$p $a-ET"; fi
  done
  echo $p > $D/PLAYED
}
screen() {  # screen <tier> <level> <seeds> <seed-base>
  local D=tmp/v55/W/$1; mkdir -p $D/screen $D/confirm
  played $D
  for arm in base $(cat $D/PLAYED); do bp $D/configs/$arm.json $D/screen/rol-$arm.jsonl $2 $3 $4; done
  { echo "Level $2, $3 seeds from $4"; python3 engine-rs/scripts/v51b_report.py --roll-screen $D; echo; \
    python3 engine-rs/scripts/v51c_report.py --roles $(for a in base $(cat $D/PLAYED); do echo $D/screen/rol-$a.jsonl; done); } > $D/screen.md 2>&1
  python3 engine-rs/scripts/v51b_report.py --roll-select $D > $D/selected.txt 2> $D/selection.log
  echo "R8 $1 SCREEN DONE $(date '+%F %T'); selected: $(cat $D/selected.txt)"
}
confirm() {  # confirm <tier> <level> <seeds> <seed-base>
  local D=tmp/v55/W/$1 sel; sel=$(tr -d ' \n' < $D/selected.txt)
  if [ -z "$sel" ]; then echo "No $1 arm cleared; no confirmation." > $D/confirm.md; echo "R8 $1 CONFIRM DONE (none)"; return; fi
  for arm in base $sel; do bp $D/configs/$arm.json $D/confirm/rolc-$arm.jsonl $2 $3 $4 || return; done
  { python3 engine-rs/scripts/v51b_report.py --roll-confirm $D $3; echo; \
    python3 engine-rs/scripts/v51c_report.py --roles $D/confirm/rolc-base.jsonl $D/confirm/rolc-$sel.jsonl; } > $D/confirm.md 2>&1
  echo "R8 $1 CONFIRM DONE $(date '+%F %T'): $(grep '^NEW BASE' $D/confirm.md)"
}
echo "R8 start $(date '+%F %T')"
screen base 5 800 100100000
screen l6 6 800 100200000
screen pro 7 100 100300000
confirm pro 7 100 100600000
confirm base 5 800 100400000
confirm l6 6 800 100500000
echo "R8 DONE $(date '+%F %T')"
