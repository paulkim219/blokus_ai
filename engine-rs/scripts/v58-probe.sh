#!/usr/bin/env bash
# Round 11 Step A (prereg in research_paper/v5_high_budget_results.md, "Round 11"): v55_speed, one thread
# per process, 30 positions (150 of tmp/d1/x1-l6a.moves.jsonl, every 5th), six arms in two waves of three
# parallel processes (one uncapped eager arm per wave, for memory). Deterministic output; ms not used.
# usage: bash engine-rs/scripts/v58-probe.sh [pid to wait for]
set -u
T=/Users/paulkim/Blokee/tmp; V=$T/v58; B=$T/hb/bin2; C=$V/configs; P=$V/probe; LOG=$V/cpu-log.txt
POS=$T/d1/x1-l6a.moves.jsonl
mkdir -p $P; cd /Users/paulkim/Blokee-hb
if [ -n "${1:-}" ]; then while kill -0 $1 2>/dev/null; do sleep 30; done; fi
run() { /usr/bin/time -l $B/v55_speed $POS 150 5 $P/$1.csv $C/$1.json 2> $P/$1.time; }
for wave in "U U16-4 U16-8" "U-1pct U32-8 U64-16"; do
  s=$(date '+%T')
  for a in $wave; do run $a & done
  wait
  echo "$(date '+%F') $s-$(date '+%T') v58 probe v55_speed [$wave] 30 positions [3 x 1 thread]" >> $LOG
done
python3 engine-rs/scripts/v58_probe_report.py $P > $P/probe.md 2>&1
echo "$(date '+%F %T') v58 probe done" >> $LOG
