#!/usr/bin/env bash
# Amendment 3 hand-over (research_paper/v5_high_budget_results.md): stop the L9 screen after chunk 7 (48 seeds),
# read it once at N = 48, then start the L8 screen (v58-screen-l8.sh) on fresh seeds from 104,200,000.
# usage (repo root): nohup bash engine-rs/scripts/v58-switch-l8.sh <L9 chain pid> > /Users/paulkim/Blokee/tmp/v58/switch.log 2>&1 &
set -u
cd "$(dirname "$0")/../.."
CHAIN=$1; S=/Users/paulkim/Blokee/tmp/v58/screen; L8=/Users/paulkim/Blokee/tmp/v58/screen-l8
echo "switch start $(date '+%F %T'); waiting for L9 chunk 7 to start (chain pid $CHAIN)"
until grep -q "^=== scr-.*-c7 start" $S/chain.log; do
  kill -0 $CHAIN 2>/dev/null || { echo "L9 chain gone before chunk 7 started $(date '+%F %T'); nothing switched"; exit 1; }
  sleep 60
done
touch $S/STOP; echo "chunk 7 started; STOP touched $(date '+%F %T') (chain ends after chunk 7)"
while kill -0 $CHAIN 2>/dev/null; do sleep 60; done
echo "L9 chain ended $(date '+%F %T')"
grep -q "SCREEN CHUNK 7 DONE" $S/chain.log || { echo "chunk 7 not complete; no read, no L8 launch"; exit 1; }
caffeinate -i -s -m -w $$ &
bash engine-rs/scripts/v58-screen-read.sh 48 > $S/read-48.log 2>&1; echo "L9 read at N=48 exit $? -> $S/read-48/screen.md $(date '+%F %T')"
mkdir -p $L8; cp $S/manifest.json $S/COSTS $L8/
bash engine-rs/scripts/v58-screen-l8.sh > $L8/chain.log 2>&1 &
P=$!; echo $P > $L8/chain.pid
caffeinate -i -s -m -w $P &
echo "L8 screen launched pid $P $(date '+%F %T')"
