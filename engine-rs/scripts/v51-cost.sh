#!/usr/bin/env bash
# Clean cost (ms/move, own moves 3+) of v5.1 arms against base: p4_cost, 150 recorded positions,
# 2 threads, two rounds (round 2 in reverse order). Quiet machine only (no matches running).
#   engine-rs/scripts/v51-cost.sh ROOT TAG ARM...      -> ROOT/cost/TAG-round{1,2}.{csv,names}
set -u
cd "$(dirname "$0")/../.."
ROOT=$1; TAG=$2; shift 2
BIN=${BIN:-$ROOT/bin}
mkdir -p "$ROOT/cost"
fwd="base $*"; rev=$(echo $fwd | tr ' ' '\n' | tail -r | tr '\n' ' ')
for r in 1 2; do
  if [ $r = 1 ]; then names=$fwd; else names=$rev; fi
  echo $names > "$ROOT/cost/$TAG-round$r.names"
  cfgs=""; for a in $names; do cfgs="$cfgs $ROOT/configs/$a.json"; done
  echo "$TAG round $r start $(date '+%F %T') load $(uptime | sed 's/.*averages*: //')"
  "$BIN/p4_cost" tmp/d1/x1-l6a.moves.jsonl 150 2 "$ROOT/cost/$TAG-round$r.csv" $cfgs 2>&1 | grep -v "^$" | tail -2
done
echo "$TAG done $(date '+%F %T') load $(uptime | sed 's/.*averages*: //')"
