#!/usr/bin/env bash
# Hybrid H2 (research_paper/v5_hybrid_preregistered.md, "H2", in force): the H1 network's prior inside the v5 tree,
# synchronous, one search thread per game, against v5.3-turbo and v5.3-pro at equal wall time on the PC.
#
# Run on the PC from the repo root, in tmux:   bash engine-rs/scripts/h2-chain.sh
# Resumable: every step leaves tmp/h2/steps/<step>.done and is skipped on a rerun; match steps resume seed by seed
# (blokee-pentobi skips the seed/seat pairs already in its --out file). After a Windows restart, rerun the same
# command (docs/HYBRID_HANDOFF.md). Writes tmp/h2/SUMMARY.txt and the H2 results section, commits locally, and
# pushes branch hybrid-h2 to the `github` remote if the PC has credentials (Paul approved pushing hybrid-* branches).
set -u
cd "$(git rev-parse --show-toplevel)"
H=tmp/h2; S=$H/steps; G=$H/games
mkdir -p $S $G $H/configs $H/dev $H/bin
P=ml/.venv-hybrid/bin/python
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
SMI=/usr/lib/wsl/lib/nvidia-smi
log() { echo "$(date '+%F %T') $*" | tee -a $H/chain.log; }
fail() { log "FAILED at step $1 (see $S/$1.log); fix and rerun"; echo "H2 chain FAILED at step $1 at $(date '+%F %T'); log $S/$1.log" > $H/SUMMARY.txt; exit 1; }
step() { # name, command...
  local name=$1; shift
  [ -f $S/$name.done ] && return 0
  log "step $name: start"
  local t0=$(date +%s)
  if "$@" >> $S/$name.log 2>&1; then touch $S/$name.done; log "step $name: done in $(( ($(date +%s) - t0) / 60 )) min"
  else fail $name; fi
}
source $HOME/.cargo/env
source engine-rs/scripts/h0-env.sh
[ -f $S/report.done ] || echo "H2 chain running since $(date '+%F %T'); steps in $H/chain.log" > $H/SUMMARY.txt
log "chain start ($(git rev-parse --short HEAD))"

# 0. Build (ort) and pin the binaries for the whole stage.
build() {
  (cd engine-rs && CARGO_TARGET_DIR=target-ort cargo build --release --features ort --bins --examples) &&
  cp engine-rs/target-ort/release/blokee-pentobi engine-rs/target-ort/release/examples/h2_cost $H/bin/ &&
  git rev-parse --short HEAD > $H/bin/COMMIT
}
step build build
cp engine-rs/configs/v5.3-turbo.json $H/configs/control-turbo.json
cp tmp/h1/configs/v5.3-pro.json $H/configs/control-pro.json

# 1. Development steps (recorded positions, no games): T, then equal-wall-time calibration of each arm.
step probe-t-turbo python3 engine-rs/scripts/h2_calibrate.py probe-t turbo
step probe-t-pro python3 engine-rs/scripts/h2_calibrate.py probe-t pro
for arm in T-R50 T-R100 T-RI P-R50 P-RI; do
  tier=turbo; [[ $arm == P-* ]] && tier=pro
  step cal-$arm python3 engine-rs/scripts/h2_calibrate.py calibrate $tier $arm
done

# matches: stage tier config seeds seed-base level threads
play() {
  local stage=$1 tier=$2 cfg=$3 seeds=$4 base=$5 level=$6 threads=$7
  local out=$G/$stage-$tier-$cfg
  local conf=$H/configs/$cfg.json; [ $cfg = control ] && conf=$H/configs/control-$tier.json
  $SMI --query-gpu=power.draw,utilization.gpu --format=csv,noheader -l 5 >> $out.gpu.csv 2>/dev/null &
  local smi=$!
  $H/bin/blokee-pentobi --blokee $conf --blokee-name $cfg --pentobi $PENTOBI --book $BOOK --mode one-blokee --gtp-processes per-seat \
    --level $level --budget 300 --threads $threads --seeds $seeds --seed-base $base --label h2-$stage-$tier-$cfg \
    --out $out.jsonl --moves-out $out.moves.jsonl
  local rc=$?
  kill $smi 2>/dev/null
  [ $rc -eq 0 ] && [ "$(wc -l < $out.jsonl)" -eq $((seeds * 4)) ]
}

# 2. Smoke games on development seeds (not results): every arm loads and plays one seed x 4 rotations.
for arm in T-R50 T-R100 T-RI; do step smoke-turbo-$arm play smoke turbo $arm 1 105490000 6 4; done
for arm in P-R50 P-RI; do step smoke-pro-$arm play smoke pro $arm 1 105590000 7 4; done

# 3. Turbo: screen (300 seeds from 105,500,000 vs level 6), read, confirmation of the selected arm if any
#    (800 seeds from 105,700,000).
for cfg in control T-R50 T-R100 T-RI; do step screen-turbo-$cfg play screen turbo $cfg 300 105500000 6 12; done
step read-screen-turbo $P engine-rs/scripts/h2_report.py screen turbo
SEL=$($P -c "import json;print(json.load(open('$H/turbo-screen.json'))['selected'] or '')")
if [ -n "$SEL" ]; then
  for cfg in control $SEL; do step confirm-turbo-$cfg play confirm turbo $cfg 800 105700000 6 12; done
  step read-confirm-turbo $P engine-rs/scripts/h2_report.py confirm turbo
else log "turbo: no arm cleared the screen; no confirmation (null)"; fi

# 4. Pro: screen (300 seeds from 105,600,000 vs level 7, 7 games at once for memory), read, confirmation
#    (800 seeds from 105,800,000).
for cfg in control P-R50 P-RI; do step screen-pro-$cfg play screen pro $cfg 300 105600000 7 7; done
step read-screen-pro $P engine-rs/scripts/h2_report.py screen pro
SEL=$($P -c "import json;print(json.load(open('$H/pro-screen.json'))['selected'] or '')")
if [ -n "$SEL" ]; then
  for cfg in control $SEL; do step confirm-pro-$cfg play confirm pro $cfg 800 105800000 7 7; done
  step read-confirm-pro $P engine-rs/scripts/h2_report.py confirm pro
else log "pro: no arm cleared the screen; no confirmation (null)"; fi

# 5. Read-out, local commit, push of this branch only (never forced).
report() {
  $P engine-rs/scripts/h2_report.py report || return 1
  mkdir -p research_paper/hybrid_h2_runs
  cp $H/SUMMARY.txt $H/chain.log $H/dev/probe-t-*.json $H/dev/calibration-*.json research_paper/hybrid_h2_runs/ || return 1
  cp $H/*-screen.json $H/*-confirm.json research_paper/hybrid_h2_runs/ 2>/dev/null
  local what="screens"; ls $H/*-confirm.json > /dev/null 2>&1 && what="screens and confirmations"
  git add research_paper/v5_hybrid_results.md research_paper/hybrid_h2_runs &&
  git commit -q -m "Hybrid H2 results: $what (generated on the PC by h2-chain.sh)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
}
step report report
if git push github hybrid-h2 >> $H/chain.log 2>&1; then log "pushed hybrid-h2 to github"
else log "push to github failed (no credentials on the PC?); push hybrid-h2 from elsewhere"; echo "NOTE: not pushed; see docs/HYBRID_HANDOFF.md" >> $H/SUMMARY.txt; fi
log "H2 CHAIN DONE; summary $H/SUMMARY.txt. Next decisions are Paul's (docs/HYBRID_HANDOFF.md)."
