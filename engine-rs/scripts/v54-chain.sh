#!/usr/bin/env bash
# Round 7 driver (preregistered 2026-11-15 16:55, "round 7" entry). Sentinels "R7 ULTRA STOPPED",
# "R7 C SCREEN DONE", "R7 C DONE", "R7 D DONE", "R7 DONE". Binary tmp/v53/bin.
set -u
cd "$(dirname "$0")/../.."
R=tmp/v54; BIN=tmp/v53/bin; G=engine-rs/configs; D=$R/C
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
ok() { h=$(date +%H%M); [ "$h" -lt 0730 ] || [ "$h" -ge 1200 ]; }
bp() {
  local cfg=$1 out=$2 mode=$3 lvl=$4 n=$5 sb=$6 th=$7; shift 7
  ok || { echo "=== $(basename $out .jsonl) NOT STARTED (07:30)"; return; }
  echo "=== $(basename $out .jsonl) start $(date '+%F %T')"
  "$BIN/blokee-pentobi" --blokee "$cfg" --pentobi "$PENTOBI" --book "$BOOK" --mode "$mode" --gtp-processes per-seat \
    --level "$lvl" --budget 300 --threads "$th" --seeds "$n" --seed-base "$sb" --label "$(basename $out .jsonl)" \
    --out "$out" --moves-out "${out%.jsonl}.moves.jsonl" "$@" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror" || true
  echo "=== $(basename $out .jsonl) done $(date '+%F %T')"
}
# ---------------- ultra: runs until it finishes or 22:00, then stopped (complete seeds are reported)
echo "R7 start $(date '+%F %T'); waiting for ultra-L9 (until 22:00)"
while pgrep -f "label ultra-L9" > /dev/null; do
  h=$(date +%H%M); if [ "$h" -ge 2200 ] || [ "$h" -lt 1200 ]; then pkill -f "label ultra-L9"; sleep 10; break; fi
  sleep 60
done
pkill -f "pentobi-gtp --game classic --level 9" 2>/dev/null
python3 engine-rs/scripts/v53_report.py --tiers tmp/v53 > tmp/v53/S2/tiers.md 2>&1
echo "R7 ULTRA STOPPED $(date '+%F %T'); games $(wc -l < tmp/v53/S2/ultra-L9.jsonl)"
sleep 30
# ---------------- C: pro-tier arms, clean cost on 60 positions (quiet), re-time, screen vs level 7
arms=$(cat $D/ARMS)
mkdir -p $D/cost
for r in 1 2; do
  names="base $arms"; [ $r = 2 ] && names=$(echo base $arms | tr ' ' '\n' | tail -r | tr '\n' ' ')
  echo $names > $D/cost/screen-round$r.names
  cfgs=""; for a in $names; do cfgs="$cfgs $D/configs/$a.json"; done
  $BIN/p4_cost tmp/d1/x1-l6a.moves.jsonl 60 2 $D/cost/screen-round$r.csv $cfgs 2>&1 | tail -1
done
python3 engine-rs/scripts/v51_report.py --cost $D screen | tee $D/cost/screen-cost.md
played=""
for a in $arms; do
  c=$(python3 -c "import json; print(json.load(open('$D/COSTS'))['$a'])")
  if python3 -c "import sys; sys.exit(0 if 0.97 <= float('$c') <= 1.03 else 1)"; then played="$played $a"; else
    python3 engine-rs/scripts/v51b_configs.py retime $D $a "$c" > /dev/null; played="$played $a-ET"; fi
done
echo "played: $played (re-timed arms not re-checked at this budget: 60-position cost rounds take ~10 min)"
echo $played > $D/PLAYED
mkdir -p $D/screen $D/confirm
for arm in base $played; do
  bp $D/configs/$arm.json $D/screen/rol-$arm.jsonl one-blokee 7 100 99000000 10
done
{ python3 engine-rs/scripts/v51b_report.py --roll-screen $D; echo; python3 engine-rs/scripts/v51c_report.py --roles $(for a in base $played; do echo $D/screen/rol-$a.jsonl; done); } > $D/screen.md 2>&1
python3 engine-rs/scripts/v51b_report.py --roll-select $D > $D/selected.txt 2> $D/selection.log
echo "R7 C SCREEN DONE $(date '+%F %T')"
sel=$(tr -d ' \n' < $D/selected.txt)
if [ -n "$sel" ]; then
  for arm in base $sel; do bp $D/configs/$arm.json $D/confirm/rolc-$arm.jsonl one-blokee 7 100 99100000 5 & done
  wait
  { python3 engine-rs/scripts/v51b_report.py --roll-confirm $D; echo; python3 engine-rs/scripts/v51c_report.py --roles $D/confirm/rolc-base.jsonl $D/confirm/rolc-$sel.jsonl; } > $D/confirm.md 2>&1
  win=$(sed -n 's/^NEW BASE: //p' $D/confirm.md)
  if [ -n "$win" ] && [ "$win" != "(none)" ]; then
    cp $D/configs/$win.json $G/v5.3-cand-pro.json
    # the same change at the v5.2-turbo (was v5.2-l6) budget vs level 6 (descriptive), 400 seeds 99,200,000
    python3 - "$win" <<'PY'
import json, sys
w = json.load(open(f"tmp/v54/C/configs/{sys.argv[1]}.json")); l6 = json.load(open("engine-rs/configs/v5.2-turbo.json"))
for k in ("rave", "selection", "candidates"):
    l6["native"][k] = w["native"][k]
json.dump(l6, open("tmp/v54/C/configs/l6-arm.json", "w"), indent=1)
PY
    cp $G/v5.2-turbo.json $D/configs/l6-base.json
    for arm in l6-base l6-arm; do bp $D/configs/$arm.json $D/confirm/l6c-$arm.jsonl one-blokee 6 400 99200000 10; done
  fi
else
  echo "No pro arm cleared; no confirmation." > $D/confirm.md
fi
cat $D/confirm.md
echo "R7 C DONE $(date '+%F %T')"
# ---------------- D: benchmark fill-ins
S=tmp/v53/S3
bp $G/v5.2-nano.json $S/nano-vs-L3.jsonl one-blokee 3 200 97960000 10
bp $G/v5.2-nano.json $S/nano-vs-L4.jsonl one-blokee 4 200 97970000 10
bp $G/v5.2-turbo.json $S/l6-vs-L5.jsonl one-blokee 5 200 97980000 10
bp $G/v5.2-pro.json $S/pro-vs-L6.jsonl one-blokee 6 100 97995000 10
bp $G/v5.2-turbo.json $S/l6-vs-L7.jsonl one-blokee 7 100 97990000 10
bp $G/v5.1-ultra.json $S/ladder-L6-vs-L7.jsonl pentobi-ladder 7 100 97550000 10 --lone-level 6
python3 engine-rs/scripts/v53_report.py --bench tmp/v53 > $S/bench.md 2>&1
echo "R7 D DONE $(date '+%F %T')"
echo "R7 DONE $(date '+%F %T')"
