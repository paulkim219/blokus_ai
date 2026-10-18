#!/bin/zsh
# E4 — expert iteration with the native engine (AlphaZero-style, rollouts kept as the leaf value).
#
#   zsh ml/torch/expert_iteration.sh <start-checkpoint.pt> <arm> [generations] [games-per-gen]
#
# Runbook (setup on another machine, gates, outputs): docs/E4_RUNBOOK.md.
#
# Each generation:
#   1. serve the current network as the root prior of v4.2-ultra (blend/temperature from E3a);
#   2. play GAMES native self-play games with that engine — its root visits are the improved policy
#      target, its final scores the value target;
#   3. warm-start the next network from the current one and train on this generation plus the
#      previous REPLAY generations (and BASE_RUN, the 20k-game v4.1-ultra corpus, when present);
#   4. gate next vs current, both served, over GATE_SEEDS seat-rotated seeds; keep next only if the
#      advantage is positive. A rejected generation's data still enters the replay window.
#
# After the last generation the final network, served, plays plain v4.2-ultra (no prior) over
# FINAL_SEEDS seeds from 74,000,000: that match, not the gates, is the E4 result.
#
# Seeds: generation k plays 62,000,000 + k·100,000 + i; gates use 73,000,000 + k·1,000 + i. Neither
# range overlaps the E1 training data (61,000,000+) or the E3a/settle-fix evaluation seeds. Every
# output lands under DIR, so an interrupted run is resumed by RESUME=<generation> with START set to
# the network that generation should play with (see the runbook).
set -eu
cd "$(dirname "$0")/../.."
START=$1; ARM=$2; GENERATIONS=${3:-8}; GAMES=${4:-2000}
BUDGET=${BUDGET:-300}; STEPS=${STEPS:-4000}; REPLAY=${REPLAY:-3}; GATE_SEEDS=${GATE_SEEDS:-50}
BLEND=${BLEND:-0.5}; TEMPERATURE=${TEMPERATURE:-1.0}; THREADS=${THREADS:-$(( $(getconf _NPROCESSORS_ONLN) - 1 ))}
TEST_GAMES=${TEST_GAMES:-100}; VAL_GAMES=${VAL_GAMES:-50}; FINAL_SEEDS=${FINAL_SEEDS:-200}; RESUME=${RESUME:-0}; BASE_CONFIG=${BASE_CONFIG:-engine-rs/configs/v4.2-ultra.json}
PY=${PY:-ml/.venv-torch/bin/python}; BIN=engine-rs/target/release; BASE_RUN=${BASE_RUN-ml/data/selfplay-v41u-300}
DIR=${DIR:-ml/data/expert-iteration}; mkdir -p $DIR/nets tmp
[ -n "$BASE_RUN" ] && [ ! -d "$BASE_RUN" ] && { echo "BASE_RUN $BASE_RUN not found (set BASE_RUN= to train without it)"; exit 1; }
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a $DIR/log.txt; }

config() {  # config <socket> <out.json>
  $PY - "$1" "$2" "$BLEND" "$TEMPERATURE" "$BASE_CONFIG" <<'EOF'
import json, sys
socket, out, blend, temperature, base = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
params = json.load(open(base))
params["native"] = {"prior": {"socket": socket, "blend": blend, "temperature": temperature, "phase": "all", "pseudoVisits": 0}}
json.dump(params, open(out, "w"))
EOF
}

serve() {  # serve <checkpoint> <socket>  → pid on stdout
  rm -f "$2"
  $PY ml/torch/serve.py --checkpoint "$1" --socket "$2" >> $DIR/serve.log 2>&1 &
  echo $!
  while [ ! -S "$2" ]; do sleep 1; done
}

current=$START
log "start: $START ($ARM), generations $RESUME..$((GENERATIONS - 1)), $GAMES games, $THREADS threads, base $BASE_CONFIG"
for k in $(seq $RESUME $((GENERATIONS - 1))); do
  run=$DIR/gen-$k
  log "generation $k: self-play with $current"
  pid=$(serve $current /tmp/blokee-ei-a.sock); config /tmp/blokee-ei-a.sock $DIR/gen-$k.json
  $BIN/blokee-selfplay --config $DIR/gen-$k.json --games $GAMES --budget $BUDGET --threads $THREADS \
    --seed-base $((62000000 + k * 100000)) --out $run 2>> $DIR/log.txt
  kill $pid

  extra=(); [ -n "$BASE_RUN" ] && extra+=($BASE_RUN)
  for j in $(seq $((k - 1)) -1 $((k - REPLAY))); do [ $j -ge 0 ] && extra+=($DIR/gen-$j); done
  next=$DIR/nets/ei-gen$((k + 1)).pt
  log "generation $k: training $next (replay: ${extra[*]})"
  $PY ml/torch/train.py --arm $ARM --run $run --extra-runs ${extra[@]} --init $current \
    --train-games $((GAMES - TEST_GAMES - VAL_GAMES)) --test-games $TEST_GAMES --val-games $VAL_GAMES --steps $STEPS --lr 1e-4 \
    --name ei-gen$((k + 1)) --out $DIR/nets >> $DIR/train.log 2>&1

  log "generation $k: gating ei-gen$((k + 1)) vs current"
  pa=$(serve $next /tmp/blokee-ei-a.sock); config /tmp/blokee-ei-a.sock $DIR/challenger.json
  pb=$(serve $current /tmp/blokee-ei-b.sock); config /tmp/blokee-ei-b.sock $DIR/champion.json
  gate=$DIR/gate-$k.jsonl; rm -f $gate
  $BIN/blokee-match --challenger $DIR/challenger.json --champion $DIR/champion.json --seeds $GATE_SEEDS \
    --seed-base $((73000000 + k * 1000)) --budget $BUDGET --threads $THREADS --out $gate 2>> $DIR/log.txt
  kill $pa $pb
  summary=$(npx tsx scripts/aggregateMatches.ts $gate | grep Advantage)
  log "generation $k gate: $summary"
  mean=$(echo $summary | sed -E 's/.*: (-?[0-9.]+) \[.*/\1/')
  if (( $(echo "$mean > 0" | bc -l) )); then current=$next; log "accepted ei-gen$((k + 1))"; else log "rejected ei-gen$((k + 1))"; fi
done
log "final network: $current"

log "final: $current (served) vs plain $(basename $BASE_CONFIG .json), $FINAL_SEEDS seeds"
pa=$(serve $current /tmp/blokee-ei-a.sock); config /tmp/blokee-ei-a.sock $DIR/final.json
final=$DIR/final.jsonl; rm -f $final
$BIN/blokee-match --challenger $DIR/final.json --champion $BASE_CONFIG --seeds $FINAL_SEEDS \
  --seed-base 74000000 --budget $BUDGET --threads $THREADS --label e4-final --out $final 2>> $DIR/log.txt
kill $pa
npx tsx scripts/aggregateMatches.ts $final | tee $DIR/final.txt
log "final match: $(grep Advantage $DIR/final.txt)"
