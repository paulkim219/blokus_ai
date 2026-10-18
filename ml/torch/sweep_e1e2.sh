#!/bin/zsh
# E1/E2 sweep, queued behind the self-play run. GPU-bound; arms get roughly equal GPU time
# (~45–50 min) except conv-small, which is cheap enough to run the full data-scaling curve.
set -u
cd "$(dirname "$0")/../.."
PY=ml/.venv-torch/bin/python
RUN=ml/data/selfplay-v41u-300
OUT=ml/torch/results
mkdir -p $OUT tmp
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a tmp/sweep-e1e2.log; }
train() { log "start $*"; $PY ml/torch/train.py --run $RUN --out $OUT "$@" >> tmp/sweep-e1e2.log 2>&1; log "done $*"; }

# E1: data scaling at fixed architecture and steps.
train --arm conv-small --train-games 1000 --steps 20000
train --arm conv-small --train-games 5000 --steps 20000
train --arm conv-small --train-games 18500 --steps 20000
train --arm resnet --train-games 5000 --steps 8000
train --arm resnet --train-games 18500 --steps 8000
# E2: global attention at roughly matched GPU time.
train --arm vit-patch --train-games 18500 --steps 6000
train --arm vit-cell --train-games 18500 --steps 3000
log "sweep complete"
