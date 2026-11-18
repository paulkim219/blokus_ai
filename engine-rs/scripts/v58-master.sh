#!/usr/bin/env bash
# Round 11 Steps A-C in sequence after screen P2's chain exits (pid $1). Stops before the pilot.
set -u
V=/Users/paulkim/Blokee/tmp/v58; cd /Users/paulkim/Blokee-hb
while kill -0 $1 2>/dev/null; do sleep 30; done
echo "$(date '+%F %T') P2 chain gone; round 11 A-C start" >> $V/cpu-log.txt
sleep 60
bash engine-rs/scripts/v58-mem.sh
bash engine-rs/scripts/v58-probe.sh
ARM=$(awk '/^chosen:/{print $2}' $V/probe/probe.md)
echo "$(date '+%F %T') chosen arm: $ARM" >> $V/cpu-log.txt
bash engine-rs/scripts/v58-cost.sh "$ARM"
echo "$(date '+%F %T') round 11 A-C done" >> $V/cpu-log.txt
touch $V/AC_DONE
