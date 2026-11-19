#!/usr/bin/env bash
# Hybrid H0 gate G3d: the E6 root-prior call through serve.py's socket and through the in-process
# evaluator, on the same positions and in whole games. Run on the PC from the repo root.
#   engine-rs/scripts/h0-e2e.sh [out-dir]
set -u
OUT=${1:-tmp/h0/e2e}; mkdir -p $OUT
source engine-rs/scripts/h0-env.sh
BIN=engine-rs/target-ort/release
REC=${REC:-tmp/h0/encoding/records.bin}
M=$PWD/ml/data/onnx/resnet2-b8w96-g36k-s0
PY=ml/.venv-hybrid/bin/python
CKPT=ml/torch/results/resnet2-b8w96-g36k-s0.pt
B=engine-rs/configs/v4.2-ultra.json
SOCK=/tmp/blokee-h0-e2e.sock
log() { echo "$(date '+%F %T') $*" | tee -a $OUT/log.txt; }
net() {  # net <name> <json evaluator or empty>: a native.net block file
  if [ -z "$2" ]; then echo "{\"socket\": \"$SOCK\"}" > $OUT/net-$1.json
  else echo "{\"socket\": \"\", \"evaluator\": $2}" > $OUT/net-$1.json; fi
}
config() {  # config <name>: v4.2-ultra + the E6 root prior (rootBlend 0.5, no child channels) from net-<name>.json
  $PY - $B $OUT/net-$1.json $OUT/e6-$1.json <<'PY'
import json, sys
base, block, out = sys.argv[1:4]
params = json.load(open(base))
params["native"] = {"net": {**json.load(open(block)), "rootBlend": 0.5, "temperature": 1.0, "depth1Blend": 0.0,
                            "depth1Temperature": 1.0, "valueVisits": 0.0}}
json.dump(params, open(out, "w"), indent=1)
PY
}
serve() {  # serve <cpu|cuda>
  rm -f $SOCK
  if [ $1 = cpu ]; then CUDA_VISIBLE_DEVICES= $PY ml/torch/serve.py --checkpoint $CKPT --socket $SOCK --protocol 2 > $OUT/serve-$1.log 2>&1 &
  else $PY ml/torch/serve.py --checkpoint $CKPT --socket $SOCK --protocol 2 > $OUT/serve-$1.log 2>&1 & fi
  SERVER=$!
  until [ -S $SOCK ]; do sleep 1; done
  log "server: $(head -n 1 $OUT/serve-$1.log)"
}
games() {  # games <name>: 4 seeds x 4 seats against v4.2-ultra, one thread
  rm -f $OUT/games-$1.jsonl
  $BIN/blokee-match --challenger $OUT/e6-$1.json --champion $B --seeds 4 --seed-base 76900000 --budget 300 --threads 1 \
    --challenger-name e6-h0 --label h0-e2e --out $OUT/games-$1.jsonl 2> $OUT/games-$1.err
  python3 -c "import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l); d.pop('challengerSeconds',None); print(json.dumps(d,sort_keys=True))" $OUT/games-$1.jsonl | sort > $OUT/games-$1.cmp
  log "games $1: $(wc -l < $OUT/games-$1.cmp) games; $(tail -n 1 $OUT/games-$1.err)"
}
same_games() {
  if cmp -s $OUT/games-$1.cmp $OUT/games-$2.cmp; then log "games $1 == $2 (every game, all fields but challengerSeconds)"
  else log "games $1 != $2: $(diff $OUT/games-$1.cmp $OUT/games-$2.cmp | grep -c '^<') of $(wc -l < $OUT/games-$1.cmp) games differ"; fi
}

net socket ""
net ort-cpu "{\"backend\": \"ort\", \"model\": \"$M.fp32.onnx\", \"device\": \"cpu\"}"
net ort-cuda "{\"backend\": \"ort\", \"model\": \"$M.fp32.onnx\", \"device\": \"cuda\"}"
net ort-cuda-tf32 "{\"backend\": \"ort\", \"model\": \"$M.fp32.onnx\", \"device\": \"cuda\", \"tf32\": true}"
for n in socket ort-cpu ort-cuda ort-cuda-tf32; do config $n; done

# Gated pair: both exact fp32 (server on the CPU, ort CPU provider).
serve cpu
for batch in 1 41; do
  log "G3d positions socket(cpu) vs ort-cpu, batch $batch: $($BIN/examples/h0_e2e $REC 2000 $batch $OUT/net-socket.json $OUT/net-ort-cpu.json)"
done
cp $OUT/e6-socket.json $OUT/e6-socket-cpu-server.json; games socket-cpu-server
kill $SERVER; wait $SERVER 2>/dev/null
games ort-cpu
same_games socket-cpu-server ort-cpu

# Reported pair: the server under its defaults on CUDA (TF32 convolutions), ort CUDA (TF32 off and on).
serve cuda
for batch in 1 41; do
  for n in ort-cuda ort-cuda-tf32; do
    log "positions socket(cuda) vs $n, batch $batch: $($BIN/examples/h0_e2e $REC 2000 $batch $OUT/net-socket.json $OUT/net-$n.json)"
  done
done
cp $OUT/e6-socket.json $OUT/e6-socket-cuda-server.json; games socket-cuda-server
kill $SERVER; wait $SERVER 2>/dev/null
games ort-cuda
same_games socket-cuda-server ort-cuda
same_games ort-cpu ort-cuda

# Functional: one ort CUDA session shared by four match threads (no comparison, must not fail).
rm -f $OUT/games-ort-cuda-4threads.jsonl
$BIN/blokee-match --challenger $OUT/e6-ort-cuda.json --champion $B --seeds 4 --seed-base 76900000 --budget 300 --threads 4 \
  --challenger-name e6-h0 --label h0-e2e --out $OUT/games-ort-cuda-4threads.jsonl 2> $OUT/games-ort-cuda-4threads.err
log "4 threads sharing one ort CUDA session: $(wc -l < $OUT/games-ort-cuda-4threads.jsonl) games; $(tail -n 1 $OUT/games-ort-cuda-4threads.err)"
log "H0 E2E DONE"
