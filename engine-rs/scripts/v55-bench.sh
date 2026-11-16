#!/usr/bin/env bash
# Round 8 follow-up (prereg 2026-11-16 10:59, "round 8" entry): after v55-chain.sh ends, save each tier's
# accepted arm as engine-rs/configs/v5.3-cand*.json and fill in its benchmark anchors (bench.sh layout,
# seeds from 100,700,000; the confirmation block is linked in as the tier's own-level anchor).
# No block starts at or after 19:15.
set -u
cd "$(dirname "$0")/../.."
while ! grep -q "R8 DONE" tmp/v55/W/chain.log; do sleep 30; done
ok() { h=$(date +%H%M); [ "$h" -lt 1915 ]; }
run() {  # run <tier> <name> <cfgname> <own level> <confirm seeds> <anchors> <seeds> <seed-base>
  local D=tmp/v55/W/$1 win; win=$(sed -n 's/^NEW BASE: //p' $D/confirm.md 2>/dev/null)
  if [ -z "$win" ] || [ "$win" = "(none)" ]; then echo "$1: nothing accepted"; return; fi
  cp $D/configs/$win.json engine-rs/configs/$3.json; echo "$1: $win saved as engine-rs/configs/$3.json"
  local B=tmp/bench/$2; mkdir -p $B
  for x in jsonl moves.jsonl timing.jsonl; do ln -sf ../../../$D/confirm/rolc-$win.$x $B/vs-L$4.$x; done
  for k in $6; do
    ok || { echo "$2 vs L$k NOT STARTED (19:15)"; continue; }
    engine-rs/scripts/bench.sh engine-rs/configs/$3.json $2 "$k" $7 $8 12 tmp/v55/bin-w1
  done
}
run base v5.3-cand v5.3-cand 5 800 "4 6" 200 100700000
run l6 v5.3-cand-l6 v5.3-cand-l6 6 800 "5" 200 100800000
run pro v5.3-cand-pro v5.3-cand-pro 7 100 "6" 100 100900000
run l6 v5.3-cand-l6 v5.3-cand-l6 6 800 "7" 100 100800000
args=""; for n in v5.3-cand v5.3-cand-l6 v5.3-cand-pro; do [ -d tmp/bench/$n ] && args="$args --engine $n tmp/bench/$n"; done
python3 engine-rs/scripts/v53_report.py --bench tmp/v53 $args > tmp/v55/bench.md 2>&1
echo "R8 BENCH DONE $(date '+%F %T')"
