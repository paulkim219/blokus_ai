#!/bin/zsh
# E6 screen — the network inside the rollout search (preregistered 2026-11-12, research_paper/
# v6_native_and_learning_preregistered.md). Runbook: docs/E6_RUNBOOK.md.
#
#   zsh ml/torch/e6_screen.sh <checkpoint.pt>
#   e.g. nohup zsh ml/torch/e6_screen.sh ml/torch/results/resnet2-b8w96-g18500-s0.pt > tmp/e6-screen.out 2>&1 &
#
# Serves the checkpoint with `ml/torch/serve.py --protocol 2`, writes the arm configs from
# v4.2-ultra, and plays each arm against plain v4.2-ultra on seeds 76,000,000–76,000,399 at budget
# 300, seat-rotated:
#   P0   root prior 0.5                      (control)
#   P1   + depth-1 policy 0.5
#   V64  + root-child value, n_v = 64
#   V512 + root-child value, n_v = 512
#   PV   depth-1 policy 0.5 + the better n_v (higher mean against v4.2-ultra; 64 on a tie)
# Each arm is scored with scripts/aggregateMatches.ts and every non-control arm is paired against
# P0 with ml/seat/paired_report.py (an arm advances if that CI's lower bound is above 0).
#
# Resumable: each arm is played in chunks of CHUNK seeds, one JSONL per chunk under
# ml/data/e6/<arm>/; a complete chunk is skipped on rerun, a partial one is replayed. Just run the
# same command again after an interruption.
#
# Environment (defaults are the preregistered screen; changing SEEDS/SEED_BASE/BUDGET changes the
# experiment and is for smoke tests only):
#   SEEDS=400 SEED_BASE=76000000 BUDGET=300 CHUNK=50 THREADS=<cores − 3>
#   DIR=ml/data/e6 PY=ml/.venv-torch/bin/python SERVE=ml/torch/serve.py SERVE_ARGS=
#   SOCKET=/tmp/blokee-e6-screen.sock BASE_CONFIG=engine-rs/configs/v4.2-ultra.json
set -eu
cd "$(dirname "$0")/../.."
CKPT=${1:?usage: zsh ml/torch/e6_screen.sh <checkpoint.pt>}
SEEDS=${SEEDS:-400}; SEED_BASE=${SEED_BASE:-76000000}; BUDGET=${BUDGET:-300}; CHUNK=${CHUNK:-50}
THREADS=${THREADS:-$(( $(getconf _NPROCESSORS_ONLN) - 3 ))}
DIR=${DIR:-ml/data/e6}; PY=${PY:-ml/.venv-torch/bin/python}; SERVE=${SERVE:-ml/torch/serve.py}; SERVE_ARGS=${SERVE_ARGS:-}
SOCKET=${SOCKET:-/tmp/blokee-e6-screen.sock}; BASE_CONFIG=${BASE_CONFIG:-engine-rs/configs/v4.2-ultra.json}
BIN=${BIN:-engine-rs/target/release}
mkdir -p $DIR
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a $DIR/log.txt; }

[ -f "$CKPT" ] || { echo "checkpoint $CKPT not found"; exit 1; }
[ -x $BIN/blokee-match ] || { echo "build the engine first: npm run native:build"; exit 1; }
grep -q -- "--protocol" $SERVE || { echo "$SERVE has no --protocol option (protocol 2 needed)"; exit 1; }
(( SEEDS % CHUNK == 0 )) || { echo "SEEDS must be a multiple of CHUNK"; exit 1; }

net_config() {  # net_config <out.json> [key=value...]
  local out=$1; shift
  $PY ml/torch/e6_config.py $BASE_CONFIG $out $SOCKET net rootBlend=0.5 temperature=1 depth1Temperature=1 "$@"
}

server_pid=""
stop_server() { [ -n "$server_pid" ] && kill $server_pid 2>/dev/null || true; }
trap stop_server EXIT INT TERM
rm -f $SOCKET
$PY $SERVE --checkpoint $CKPT --socket $SOCKET --protocol 2 ${=SERVE_ARGS} >> $DIR/serve.log 2>&1 &
server_pid=$!
for i in $(seq 1 120); do [ -S $SOCKET ] && break; kill -0 $server_pid 2>/dev/null || { echo "server died; see $DIR/serve.log"; exit 1; }; sleep 1; done
[ -S $SOCKET ] || { echo "server did not open $SOCKET"; exit 1; }
log "serving $CKPT (protocol 2, pid $server_pid) on $SOCKET; $SEEDS seeds from $SEED_BASE, budget $BUDGET, $THREADS threads"

net_config $DIR/e6-P0.json depth1Blend=0 valueVisits=0
net_config $DIR/e6-P1.json depth1Blend=0.5 valueVisits=0
net_config $DIR/e6-V64.json depth1Blend=0 valueVisits=64
net_config $DIR/e6-V512.json depth1Blend=0 valueVisits=512

play_arm() {  # play_arm <arm>: all chunks, then pooled JSONL and aggregate summary
  local arm=$1 c base f
  mkdir -p $DIR/$arm
  for c in $(seq 0 $(( SEEDS / CHUNK - 1 ))); do
    base=$(( SEED_BASE + c * CHUNK )); f=$DIR/$arm/chunk-$base.jsonl
    if [ -f $f ] && [ $(wc -l < $f) -eq $(( CHUNK * 4 )) ]; then continue; fi
    rm -f $f
    log "$arm: seeds $base..$(( base + CHUNK - 1 ))"
    $BIN/blokee-match --challenger $DIR/e6-$arm.json --champion $BASE_CONFIG --seeds $CHUNK --seed-base $base \
      --budget $BUDGET --threads $THREADS --label e6-$arm --out $f 2>> $DIR/$arm/match.log
    grep "challenger:" $DIR/$arm/match.log | tail -1 | sed "s/^/  /" | tee -a $DIR/log.txt
  done
  cat $DIR/$arm/chunk-*.jsonl > $DIR/$arm.jsonl
  npx tsx scripts/aggregateMatches.ts $DIR/$arm.jsonl > $DIR/$arm.txt
  log "$arm vs $(basename $BASE_CONFIG .json): $(grep Advantage $DIR/$arm.txt)"
  $PY - $DIR/$arm.jsonl <<'EOF' | tee -a $DIR/log.txt
import json, sys
g = [json.loads(l) for l in open(sys.argv[1])]
s = sum(x.get("challengerSearches", 0) for x in g); e = sum(x.get("challengerNetEvals", 0) for x in g)
t = sum(x.get("challengerSeconds", 0) for x in g)
print(f"  cost: {s} searched moves, {e / max(1, s):.1f} network evaluations/move, {1000 * t / max(1, s):.1f} ms/move")
EOF
}

paired() {  # paired <arm>
  $PY ml/seat/paired_report.py $DIR/$1.jsonl $DIR/P0.jsonl --label "$1 vs P0" > $DIR/$1-vs-P0.txt
  cat $DIR/$1-vs-P0.txt | tee -a $DIR/log.txt
}

mean_of() { sed -E 's/.*: (-?[0-9.]+) \[.*/\1/' <<< "$(grep Advantage $DIR/$1.txt)"; }

for arm in P0 P1 V64 V512; do play_arm $arm; done
for arm in P1 V64 V512; do paired $arm; done

m64=$(mean_of V64); m512=$(mean_of V512)
if (( $(echo "$m512 > $m64" | bc -l) )); then nv=512; else nv=64; fi
log "PV uses n_v = $nv (V64 mean $m64, V512 mean $m512)"
echo $nv > $DIR/pv-nv.txt
net_config $DIR/e6-PV.json depth1Blend=0.5 valueVisits=$nv
play_arm PV
paired PV

{
  echo "E6 screen: $CKPT, $SEEDS seeds from $SEED_BASE, budget $BUDGET (PV n_v = $nv)"
  for arm in P0 P1 V64 V512 PV; do echo; echo "== $arm vs $(basename $BASE_CONFIG .json)"; cat $DIR/$arm.txt; done
  for arm in P1 V64 V512 PV; do echo; cat $DIR/$arm-vs-P0.txt; done
} > $DIR/summary.txt
log "done: $DIR/summary.txt"
