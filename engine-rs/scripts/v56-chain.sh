#!/usr/bin/env bash
# Round 9 driver (preregistered 2026-11-16, "round 9" entry): does the interior cap carry to nano, lite and pro?
# Binary tmp/v56/bin (a copy of round 8's tmp/v55/bin-w1, engine f2c01ee; hashes in tmp/v56/bin/PROVENANCE.txt).
# Per tier ROOT = tmp/v56/<tier>: configs/, COSTS (clean cost, measured before the prereg), PLAYED,
# screen/rol-<arm>.jsonl, selected.txt, confirm/rolc-<arm>.jsonl. Pro: tmp/v56/pro/chunks/ (100-seed chunks,
# base / W1A-ET / W1D-ET in turn), merged into tmp/v56/pro/screen/. Sentinels "R9 <TIER> SCREEN DONE",
# "R9 <TIER> CONFIRM DONE", "R9 <TIER> BENCH DONE", "R9 PRO CHUNK <k> DONE", "R9 DONE".
# No block starts after 07:15 CST on 2026-11-17.
set -u
cd "$(dirname "$0")/../.."
BIN=tmp/v56/bin; G=engine-rs/configs; TH=12
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
ok() { [ "$(date +%Y%m%d%H%M)" -le 202611170715 ]; }
bp() {
  local cfg=$1 out=$2 lvl=$3 n=$4 sb=$5
  ok || { echo "=== $(basename $out .jsonl) NOT STARTED (07:15)"; return 1; }
  echo "=== $(basename $out .jsonl) start $(date '+%F %T') ($n seeds from $sb, level $lvl)"
  "$BIN/blokee-pentobi" --blokee "$cfg" --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --gtp-processes per-seat \
    --level "$lvl" --budget 300 --threads "$TH" --seeds "$n" --seed-base "$sb" --label "$(basename $out .jsonl)" \
    --out "$out" --moves-out "${out%.jsonl}.moves.jsonl" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|rror" || true
  echo "=== $(basename $out .jsonl) done $(date '+%F %T')"
}
screen() {  # screen <tier> <level> <seeds> <seed-base>
  local D=tmp/v56/$1; mkdir -p $D/screen $D/confirm
  for arm in base $(cat $D/PLAYED); do bp $D/configs/$arm.json $D/screen/rol-$arm.jsonl $2 $3 $4 || return; done
  { echo "Level $2, $3 seeds from $4"; python3 engine-rs/scripts/v51b_report.py --roll-screen $D; echo; \
    python3 engine-rs/scripts/v51c_report.py --roles $(for a in base $(cat $D/PLAYED); do echo $D/screen/rol-$a.jsonl; done); } > $D/screen.md 2>&1
  python3 engine-rs/scripts/v51b_report.py --roll-select $D > $D/selected.txt 2> $D/selection.log
  echo "R9 $1 SCREEN DONE $(date '+%F %T'); selected: $(cat $D/selected.txt)"
}
confirm() {  # confirm <tier> <level> <seeds> <seed-base>
  local D=tmp/v56/$1 sel; sel=$(tr -d ' \n' < $D/selected.txt)
  if [ -z "$sel" ]; then echo "No $1 arm cleared; no confirmation." > $D/confirm.md; echo "R9 $1 CONFIRM DONE (none)"; return; fi
  for arm in base $sel; do bp $D/configs/$arm.json $D/confirm/rolc-$arm.jsonl $2 $3 $4 || return; done
  { echo "Level $2, $3 seeds from $4"; python3 engine-rs/scripts/v51b_report.py --roll-confirm $D $3; echo; \
    python3 engine-rs/scripts/v51c_report.py --roles $D/confirm/rolc-base.jsonl $D/confirm/rolc-$sel.jsonl; } > $D/confirm.md 2>&1
  echo "R9 $1 CONFIRM DONE $(date '+%F %T'): $(grep '^NEW BASE' $D/confirm.md)"
}
bench() {  # bench <tier> <own level> <anchors> <seeds> <seed-base>: only for a tier accepted tonight
  local D=tmp/v56/$1 win name=v5.3-cand-$1; win=$(sed -n 's/^NEW BASE: //p' $D/confirm.md 2>/dev/null)
  if [ -z "$win" ] || [ "$win" = "(none)" ]; then echo "R9 $1 BENCH DONE (nothing accepted)"; return; fi
  cp $D/configs/$win.json $G/$name.json; echo "$1: $win saved as $G/$name.json"
  local B=tmp/bench/$name; mkdir -p $B
  for x in jsonl moves.jsonl timing.jsonl; do ln -sf ../../../$D/confirm/rolc-$win.$x $B/vs-L$2.$x; done
  for k in $3; do
    ok || { echo "$name vs L$k NOT STARTED (07:15)"; continue; }
    engine-rs/scripts/bench.sh $G/$name.json $name "$k" $4 $5 $TH $BIN
  done
  echo "R9 $1 BENCH DONE $(date '+%F %T')"
}
pro() {  # three 100-seed chunks from 101,500,000; base, W1A-ET, W1D-ET in turn within each chunk
  local D=tmp/v56/pro; mkdir -p $D/chunks $D/screen
  for k in 0 1 2; do
    local sb=$((101500000 + 100 * k))
    for arm in base W1A-ET W1D-ET; do bp $D/configs/$arm.json $D/chunks/rol-$arm-c$k.jsonl 7 100 $sb || break 2; done
    echo "R9 PRO CHUNK $k DONE $(date '+%F %T')"
  done
  for arm in base W1A-ET W1D-ET; do
    for x in jsonl moves.jsonl timing.jsonl; do cat $D/chunks/rol-$arm-c0.$x $D/chunks/rol-$arm-c1.$x $D/chunks/rol-$arm-c2.$x > $D/screen/rol-$arm.$x 2>/dev/null; done
  done
  python3 engine-rs/scripts/v56_pro_report.py > $D/screen.md 2>&1
  echo "R9 PRO DONE $(date '+%F %T')"
}
echo "R9 start $(date '+%F %T')"
screen nano 1 800 101100000
screen lite 3 800 101200000
confirm nano 1 800 101300000
confirm lite 3 800 101400000
bench nano 1 "2 3" 200 101600000
bench lite 3 "2 4" 200 101700000
pro
echo "R9 DONE $(date '+%F %T')"
