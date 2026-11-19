#!/usr/bin/env bash
# Hybrid H0, G3d follow-up: why games through the socket and through ort differ when per-position outputs
# agree to ~4e-6. (1) Each path is deterministic: the same match twice gives the same games. (2) Self-play
# records (every root child's visits) locate the first decision where the two paths part, and show its margin.
# Run on the PC from the repo root after h0-e2e.sh (reuses its configs).
#   engine-rs/scripts/h0-divergence.sh [e2e-dir]
set -u
E=${1:-tmp/h0/e2e}; OUT=$E/divergence; mkdir -p $OUT
source engine-rs/scripts/h0-env.sh
BIN=engine-rs/target-ort/release; PY=ml/.venv-hybrid/bin/python
CKPT=ml/torch/results/resnet2-b8w96-g36k-s0.pt; B=engine-rs/configs/v4.2-ultra.json; SOCK=/tmp/blokee-h0-e2e.sock
log() { echo "$(date '+%F %T') $*" | tee -a $OUT/log.txt; }
strip() { python3 -c "import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l); d.pop('challengerSeconds',None); print(json.dumps(d,sort_keys=True))" $1 | sort; }
match() {  # match <config> <out>
  $BIN/blokee-match --challenger $1 --champion $B --seeds 4 --seed-base 76900000 --budget 300 --threads 1 \
    --challenger-name e6-h0 --label h0-e2e --out $2 2> /dev/null
}
rm -f $OUT/*.jsonl
match $E/e6-ort-cpu.json $OUT/ort-cpu-again.jsonl
cmp -s <(strip $E/games-ort-cpu.jsonl) <(strip $OUT/ort-cpu-again.jsonl) && log "ort-cpu twice: identical" || log "ort-cpu twice: DIFFER"
match $E/e6-ort-cuda.json $OUT/ort-cuda-again.jsonl
cmp -s <(strip $E/games-ort-cuda.jsonl) <(strip $OUT/ort-cuda-again.jsonl) && log "ort-cuda twice: identical" || log "ort-cuda twice: DIFFER"

rm -f $SOCK; CUDA_VISIBLE_DEVICES= $PY ml/torch/serve.py --checkpoint $CKPT --socket $SOCK --protocol 2 > $OUT/serve-cpu.log 2>&1 &
SERVER=$!; until [ -S $SOCK ]; do sleep 1; done
match $E/e6-socket.json $OUT/socket-cpu-again.jsonl
cmp -s <(strip $E/games-socket-cpu-server.jsonl) <(strip $OUT/socket-cpu-again.jsonl) && log "socket(cpu server) twice: identical" || log "socket(cpu server) twice: DIFFER"
rm -rf $OUT/sp-socket-cpu $OUT/sp-ort-cpu
$BIN/blokee-selfplay --config $E/e6-socket.json --games 2 --budget 300 --threads 1 --seed-base 76900000 --out $OUT/sp-socket-cpu > /dev/null 2>&1
kill $SERVER; wait $SERVER 2>/dev/null
$BIN/blokee-selfplay --config $E/e6-ort-cpu.json --games 2 --budget 300 --threads 1 --seed-base 76900000 --out $OUT/sp-ort-cpu > /dev/null 2>&1
$PY - $OUT/sp-socket-cpu $OUT/sp-ort-cpu <<'PY' | tee -a $OUT/log.txt
import sys
sys.path.insert(0, "ml/torch")
import numpy as np
from records import load_run
a, _ = load_run(sys.argv[1]); b, _ = load_run(sys.argv[2])
for game in np.unique(a["game"]):
    ra, rb = a[a["game"] == game], b[b["game"] == game]
    diff = [i for i in range(min(len(ra), len(rb))) if ra[i]["chosen"] != rb[i]["chosen"] or (ra[i]["visits"] != rb[i]["visits"]).any()]
    if not diff:
        print(f"self-play game {game}: {len(ra)} decisions, identical in both paths"); continue
    i = diff[0]; x, y = ra[i], rb[i]
    n = int(x["candidates"])
    print(f"self-play game {game}: first difference at decision {i} of {len(ra)} (ply {x['ply']}, seat {x['seat']}, {n} candidates, "
          f"iterations {x['iterations']} / {y['iterations']}); chosen {x['chosen']} / {y['chosen']}; "
          f"slots with different visits: {int((x['visits'][:n] != y['visits'][:n]).sum())}; "
          f"top visits socket {sorted(x['visits'][:n].tolist(), reverse=True)[:4]}, ort {sorted(y['visits'][:n].tolist(), reverse=True)[:4]}; "
          f"earlier decisions identical: {all((ra[j]['visits'] == rb[j]['visits']).all() for j in range(i))}")
PY
log "H0 DIVERGENCE DONE"
