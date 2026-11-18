#!/usr/bin/env bash
# High-budget §3 identity and memory runs (prereg in research_paper/v5_high_budget_results.md).
# One thread, nice -n 20, sequential; safe beside round 10 (no match vs Pentobi, no timing read).
# usage: engine-rs/scripts/hb-identity.sh   (from the worktree root; data and output under /Users/paulkim/Blokee/tmp)
set -u
T=/Users/paulkim/Blokee/tmp; H=$T/hb; NEW=$H/bin; OLD=$T/v56/bin; CFG=$H/configs; I=$H/identity; LOG=$H/cpu-log.txt
REPO=$(pwd); POS=$T/d1/x1-l6a.moves.jsonl
mkdir -p $I
step() {  # step <label> <command...>: run niced, log start/end in the cpu log
  local label=$1; shift; local s=$(date '+%T')
  nice -n 20 "$@"; local rc=$?
  echo "$(date '+%F') $s-$(date '+%T') hb-identity: $label [1 thread] rc=$rc" >> $LOG
  return $rc
}
E=$REPO/engine-rs/configs
EIGHT="$E/v5.2-nano.json $E/v5.2-lite.json $E/v5.2.json $E/v5.2-turbo.json $E/v5.3-nano.json $E/v5.3-lite.json $E/v5.3.json $E/v5.3-turbo.json"
LAZY8="$E/v5.2-nano.json $E/v5.2-lite.json $E/v5.2.json $E/v5.2-turbo.json $CFG/v5.3-nano-lazy.json $CFG/v5.3-lite-lazy.json $CFG/v5.3-lazy.json $CFG/v5.3-turbo-lazy.json"
cd $REPO  # configs name ml/... relative to the repo root
# 1a/1b/2b: s4_identity dumps
step "s4_identity old 180x8" $OLD/s4_identity $I/s4-old.txt 180 1 $POS $EIGHT 2>/dev/null
step "s4_identity new 180x8" $NEW/s4_identity $I/s4-new.txt 180 1 $POS $EIGHT 2>/dev/null
step "s4_identity new lazy 180x8" $NEW/s4_identity $I/s4-lazy.txt 180 1 $POS $LAZY8 2>/dev/null
{ cmp $I/s4-old.txt $I/s4-new.txt && echo "S4 old==new: identical ($(wc -l < $I/s4-new.txt) lines)"; } || echo "S4 old!=new"
{ cmp $I/s4-new.txt $I/s4-lazy.txt && echo "S4 eager==lazy: identical ($(wc -l < $I/s4-lazy.txt) lines)"; } || echo "S4 eager!=lazy"
# 1b: blokee-match games, 2 seeds x 4 rotations, one thread
for b in old new; do
  BIN=$OLD; [ $b = new ] && BIN=$NEW
  rm -f $I/match-$b.jsonl
  step "blokee-match $b v5.3-turbo vs v5.2-turbo 2 seeds" $BIN/blokee-match --challenger $E/v5.3-turbo.json --champion $E/v5.2-turbo.json \
    --seeds 2 --seed-base 80900000 --budget 300 --threads 1 --label hb-id --out $I/match-$b.jsonl > /dev/null 2>&1
done
rm -f $I/match-lazy.jsonl
step "blokee-match new lazy challenger 2 seeds" $NEW/blokee-match --challenger $CFG/v5.3-turbo-lazy.json --champion $E/v5.2-turbo.json \
  --seeds 2 --seed-base 80900000 --budget 300 --threads 1 --label hb-id --out $I/match-lazy.jsonl > /dev/null 2>&1
# 1c/2c: v55_speed at pro, every 3rd of 150 positions (50), with peak RSS
for run in "old pro-base $OLD" "new pro-base $NEW" "old pro-W1D-ET $OLD" "new pro-W1D-ET $NEW" "new pro-W1D-ET-lazy $NEW"; do
  set -- $run
  step "v55_speed $1 $2 50 positions" /usr/bin/time -l -o $I/speed-$1-$2.time $3/v55_speed $POS 150 3 $I/speed-$1-$2.csv $CFG/$2.json 2>/dev/null
done
# 2c: ultra, every 30th of 150 positions (5)
for c in ultra-W1D ultra-W1D-lazy; do
  step "v55_speed new $c 5 positions" /usr/bin/time -l -o $I/speed-new-$c.time $NEW/v55_speed $POS 150 30 $I/speed-new-$c.csv $CFG/$c.json 2>/dev/null
done
echo "HB IDENTITY DONE $(date '+%F %T')"
