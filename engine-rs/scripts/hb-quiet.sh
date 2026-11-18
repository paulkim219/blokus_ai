#!/usr/bin/env bash
# High-budget quiet slot (prereg §3 speed; §2 arm cost): starts when round 10 (pid 28488) exits and
# the machine is quiet; at most 45 minutes; always ends with `touch tmp/hb/QUIET_DONE` (07:00 latest).
# One thread, sequential, no nice. Output tmp/hb/quiet/.
set -u
T=/Users/paulkim/Blokee/tmp; H=$T/hb; B=$H/bin2; C=$H/configs; Q=$H/quiet; LOG=$H/cpu-log.txt
POS=$T/d1/x1-l6a.moves.jsonl; E=/Users/paulkim/Blokee-hb/engine-rs/configs
mkdir -p $Q; cd /Users/paulkim/Blokee-hb
note() { echo "$(date '+%F %T') $*" | tee -a $Q/quiet.log; }
deadline_hit() { [ "$(date +%H%M)" -ge 0655 ] && [ "$(date +%H%M)" -lt 1200 ]; }
note "waiting for pid 28488"
while kill -0 28488 2>/dev/null; do deadline_hit && break; sleep 20; done
note "pid 28488 gone (or deadline); waiting for quiet (no pentobi-gtp / blokee-pentobi, load1 < 3, max 10 min)"
for i in $(seq 60); do
  deadline_hit && break
  busy=$(pgrep -f "pentobi-gtp|blokee-pentobi" | wc -l | tr -d ' ')
  load=$(sysctl -n vm.loadavg | awk '{print $2}')
  [ "$busy" -eq 0 ] && awk "BEGIN{exit !($load < 3)}" && break
  sleep 10
done
START=$(date +%s)
note "quiet slot start; load $(sysctl -n vm.loadavg); busy procs $(pgrep -f 'pentobi-gtp|blokee-pentobi' | wc -l | tr -d ' ')"
over() { [ $(( $(date +%s) - START )) -ge 2580 ] || deadline_hit; }   # 43 minutes
cost() {  # cost <label> <positions> <cfg...>: one p4_cost round, logged
  local label=$1 n=$2; shift 2; local s=$(date '+%T')
  if over; then note "SKIP $label (time)"; return 1; fi
  $B/p4_cost $POS $n 1 $Q/$label.csv "$@" 2>/dev/null
  echo "$(date '+%F') $s-$(date '+%T') QUIET p4_cost $label ($n positions) [1 thread]" >> $LOG
  printf "%s\n" "$@" > $Q/$label.names; note "done $label"
}
# §3 lazy vs eager, pro (warm-up by an unscored eager search first; two rounds, order reversed)
cost pro-r1 60 $C/pro-W1D-ET.json $C/pro-W1D-ET.json $C/pro-W1D-ET-lazy.json
cost pro-r2 60 $C/pro-W1D-ET.json $C/pro-W1D-ET-lazy.json $C/pro-W1D-ET.json
# §2 arm cost (if its config exists), same procedure
if [ -f $C/pro-W1D-AD.json ]; then
  cost ad-r1 60 $C/pro-W1D-ET.json $C/pro-W1D-ET.json $C/pro-W1D-AD.json
  cost ad-r2 60 $C/pro-W1D-ET.json $C/pro-W1D-AD.json $C/pro-W1D-ET.json
fi
# §3 turbo (v5.3-turbo has the W1A cap)
cost turbo-r1 150 $E/v5.3-turbo.json $E/v5.3-turbo.json $C/v5.3-turbo-lazy.json
cost turbo-r2 150 $E/v5.3-turbo.json $C/v5.3-turbo-lazy.json $E/v5.3-turbo.json
# §3 ultra, 5 positions, no warm-up search (each search takes about 20 s)
cost ultra-r1 5 $C/ultra-W1D.json $C/ultra-W1D-lazy.json
cost ultra-r2 5 $C/ultra-W1D-lazy.json $C/ultra-W1D.json
note "quiet slot end; load $(sysctl -n vm.loadavg)"
touch $H/QUIET_DONE
note "QUIET_DONE touched"
