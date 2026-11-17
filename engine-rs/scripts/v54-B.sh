#!/usr/bin/env bash
# Round 7 B: scaling diagnosis at the v5.2-turbo (then v5.2-l6), 4x turbo and v5.2-pro budgets (no Pentobi games). Runs alongside
# the ultra tail (3 game threads), so absolute times carry that load; relative numbers are the point.
# Sentinel "R7B DONE".
set -u
cd "$(dirname "$0")/../.."
B=tmp/v54/B; BIN=tmp/v53/bin; C=$B/configs
echo "R7B start $(date '+%F %T') load $(uptime | sed 's/.*averages*: //')"
tmp/v51/bin/p910_probe shape tmp/d1/x1-l6a.moves.jsonl 150 $B/shape.csv $C/l6.json $C/l6x4.json $C/pro.json 2>&1 | tail -1
echo "shape done $(date '+%F %T')"
"$BIN/p4_cost" tmp/d1/x1-l6a.moves.jsonl 150 1 $B/cost.csv $C/l6.json $C/l6half.json $C/l6x4.json $C/l6x4half.json $C/pro.json $C/prohalf.json 2>&1 | tail -1
echo "cost done $(date '+%F %T')"
# profiles: 25 s of `sample` on a single-threaded p4_cost run at each budget
for c in l6 pro; do
  "$BIN/p4_cost" tmp/d1/x1-l6a.moves.jsonl 150 1 $B/prof-$c.csv $C/$c.json > /dev/null 2>&1 &
  p=$!; sleep 3; sample $p 25 -file $B/sample-$c.txt > /dev/null 2>&1; kill $p 2>/dev/null; wait $p 2>/dev/null
done
echo "profiles done $(date '+%F %T')"
# subtree reuse (P8 method) at each budget, 48 games each
tmp/v51d/bin/p67_probe reuse tmp/v52/S1/e1/lone-TM.moves.jsonl $C/l6.json 48 $B/reuse-l6.csv 2>&1 | tail -1
tmp/v51d/bin/p67_probe reuse tmp/v52/S1/e1/lone-TM.moves.jsonl $C/l6x4.json 48 $B/reuse-l6x4.csv 2>&1 | tail -1
tmp/v51d/bin/p67_probe reuse tmp/v53/S2/pro-L7.moves.jsonl $C/pro.json 48 $B/reuse-pro.csv 2>&1 | tail -1
for c in l6:6967 l6x4:27866 pro:67346; do n=${c%%:*}; b=${c##*:}; python3 engine-rs/scripts/s4_report.py --reuse $B/reuse-$n.csv $b > $B/reuse-$n.md 2>&1; done
python3 engine-rs/scripts/v54_scaling.py $B > $B/scaling.md 2>&1
cat $B/scaling.md
echo "R7B DONE $(date '+%F %T')"
