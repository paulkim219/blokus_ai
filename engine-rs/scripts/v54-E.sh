#!/usr/bin/env bash
# Round 7, Stage E (preregistered 2026-11-16 05:40, "round 7, Stage E" entry). Cost round for COMBO (quiet),
# then base, IIV3-ET, COMBO-ET vs three level-7 seats, per-seat, 100 seeds 99,300,000 each, one after another.
# COMBO-ET is dropped if it cannot start before 07:30. Binary tmp/v53/bin. Sentinels "R7E COST DONE", "R7E DONE".
set -u
cd "$(dirname "$0")/../.."
E=tmp/v54/E; BIN=tmp/v53/bin
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
before() { h=$(date +%H%M); [ "$h" -lt "$1" ]; }
bp() {
  local cfg=$1 out=$2
  echo "=== $(basename $out .jsonl) start $(date '+%F %T')"
  "$BIN/blokee-pentobi" --blokee "$cfg" --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --gtp-processes per-seat \
    --level 7 --budget 300 --threads 10 --seeds 100 --seed-base 99300000 --label "$(basename $out .jsonl)" \
    --out "$out" --moves-out "${out%.jsonl}.moves.jsonl" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror" || true
  echo "=== $(basename $out .jsonl) done $(date '+%F %T')"
}
mkdir -p $E/cost
echo "R7E start $(date '+%F %T')"
for r in 1 2; do
  if [ $r = 1 ]; then names="base COMBO"; else names="COMBO base"; fi
  echo $names > $E/cost/screen-round$r.names
  cfgs=""; for a in $names; do cfgs="$cfgs $E/configs/$a.json"; done
  $BIN/p4_cost tmp/d1/x1-l6a.moves.jsonl 60 2 $E/cost/screen-round$r.csv $cfgs 2>&1 | tail -1
done
python3 engine-rs/scripts/v51_report.py --cost $E screen | tee $E/cost/screen-cost.md
c=$(python3 -c "import json; print(json.load(open('$E/COSTS'))['COMBO'])")
python3 - "$c" <<'PY'
import json, sys
c = float(sys.argv[1]); p = "tmp/v54/E/configs/COMBO.json"; cfg = json.load(open(p))
cfg["search"]["iterationScale"] = round(224.487 / c, 3)
json.dump(cfg, open("tmp/v54/E/configs/COMBO-ET.json", "w"), indent=1)
print(f"COMBO clean cost {c:.4f}; COMBO-ET iterationScale {cfg['search']['iterationScale']}")
PY
echo "R7E COST DONE $(date '+%F %T')"
mkdir -p $E/games
bp $E/configs/base.json $E/games/e-base.jsonl
bp $E/configs/IIV3-ET.json $E/games/e-IIV3-ET.jsonl
if before 0730; then bp $E/configs/COMBO-ET.json $E/games/e-COMBO-ET.jsonl; else echo "COMBO-ET NOT STARTED (07:30): dropped"; fi
python3 engine-rs/scripts/v54_E_report.py > $E/E.md 2>&1
cat $E/E.md
echo "R7E DONE $(date '+%F %T')"
