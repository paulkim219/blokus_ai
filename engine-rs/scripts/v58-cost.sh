#!/usr/bin/env bash
# Round 11 Step B: clean cost of the chosen ultra cap arm vs U (v5.2-ultra). p4_cost, one thread,
# 30 positions of tmp/d1/x1-l6a.moves.jsonl, round 9 warm-up procedure, two rounds in reverse order.
# Waits until no match/probe runs and 1-minute load < 3. usage: bash engine-rs/scripts/v58-cost.sh <arm>
set -u
T=/Users/paulkim/Blokee/tmp; V=$T/v58; B=$T/hb/bin2; C=$V/configs; Q=$V/cost; LOG=$V/cpu-log.txt
POS=$T/d1/x1-l6a.moves.jsonl; ARM=$1
mkdir -p $Q; cd /Users/paulkim/Blokee-hb
for i in $(seq 120); do
  busy=$(pgrep -f "pentobi-gtp|blokee-pentobi|v55_speed|p4_cost|cargo" | wc -l | tr -d ' ')
  load=$(sysctl -n vm.loadavg | awk '{print $2}')
  [ "$busy" -eq 0 ] && awk "BEGIN{exit !($load < 3)}" && break
  sleep 15
done
echo "$(date '+%F %T') cost start; load $(sysctl -n vm.loadavg); busy $(pgrep -f 'pentobi-gtp|blokee-pentobi|v55_speed' | wc -l | tr -d ' ')" >> $LOG
cost() { local label=$1; shift; local s=$(date '+%T')
  $B/p4_cost $POS 30 1 $Q/$label.csv "$@" 2>/dev/null
  printf "%s\n" "$@" > $Q/$label.names
  echo "$(date '+%F') $s-$(date '+%T') QUIET p4_cost $label (30 positions) [1 thread]; load after $(sysctl -n vm.loadavg)" >> $LOG; }
cost ultra-r1 $C/U.json $C/U.json $C/$ARM.json
cost ultra-r2 $C/U.json $C/$ARM.json $C/U.json
python3 engine-rs/scripts/hb_cost_report.py $Q ultra U $ARM > $Q/cost.md 2>&1
echo "$(date '+%F %T') cost done" >> $LOG
