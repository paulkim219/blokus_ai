#!/usr/bin/env bash
# Hybrid H0 gate G4: cost curve per backend (research_paper/v5_hybrid_preregistered.md). Run on the PC from
# the repo root with nothing else heavy running. Writes $OUT/rows.csv, $OUT/gpu-mem-*.txt and $OUT/log.txt.
#   engine-rs/scripts/h0-bench.sh [out-dir]
set -u
OUT=${1:-tmp/h0/bench}; mkdir -p $OUT
source engine-rs/scripts/h0-env.sh
BENCH=engine-rs/target-ort/release/examples/h0_bench
REC=${REC:-tmp/h0/encoding/records.bin}
M=$PWD/ml/data/onnx/resnet2-b8w96-g36k-s0
PY=ml/.venv-hybrid/bin/python
SMI=/usr/lib/wsl/lib/nvidia-smi
CSV=$OUT/rows.csv
log() { echo "$(date '+%F %T') $*" | tee -a $OUT/log.txt; }
quiet() {  # record what else is running before each configuration
  log "load: $(cut -d' ' -f1-3 /proc/loadavg); gpu: $($SMI --query-gpu=memory.used,utilization.gpu --format=csv,noheader); top: $(ps -eo pcpu,comm --sort=-pcpu | sed -n 2,3p | tr -s ' ' | tr '\n' ';')"
}
# GPU memory: sample every 100 ms while a CUDA configuration runs; report baseline and peak.
gpu_run() {  # gpu_run <label> <command...>
  local label=$1; shift
  local base=$($SMI --query-gpu=memory.used --format=csv,noheader,nounits)
  $SMI --query-gpu=memory.used --format=csv,noheader,nounits -lms 100 > $OUT/gpu-mem-$label.txt &
  local sampler=$!
  "$@"
  kill $sampler; wait $sampler 2>/dev/null
  log "gpu memory $label: baseline $base MiB, peak $(sort -n $OUT/gpu-mem-$label.txt | tail -n 1) MiB"
}

quiet
for p in fp32 fp16; do
  gpu_run ort-cuda-$p $BENCH --records $REC --out $CSV --label ort-cuda-$p --model $M.$p.onnx --device cuda --tf32 0 2>> $OUT/log.txt
done
gpu_run ort-cuda-fp32-tf32 $BENCH --records $REC --out $CSV --label ort-cuda-fp32-tf32 --model $M.fp32.onnx --device cuda --tf32 1 2>> $OUT/log.txt
quiet
for t in 8 16 1; do
  $BENCH --records $REC --out $CSV --label ort-cpu-fp32-t$t --model $M.fp32.onnx --device cpu --threads $t --modes host,e2e 2>> $OUT/log.txt
done
quiet
$BENCH --records $REC --out $CSV --label ort-cpu-fp16-t8 --model $M.fp16.onnx --device cpu --threads 8 --modes host,e2e 2>> $OUT/log.txt

# The existing socket path: serve.py --protocol 2 on its default device (CUDA), default and zero batching wait.
for wait in 2 0; do
  SOCK=/tmp/blokee-h0-bench.sock; rm -f $SOCK
  $PY ml/torch/serve.py --checkpoint ml/torch/results/resnet2-b8w96-g36k-s0.pt --socket $SOCK --protocol 2 \
    --max-wait-ms $wait > $OUT/serve-wait$wait.log 2>&1 &
  SERVER=$!
  until [ -S $SOCK ]; do sleep 1; done
  quiet
  gpu_run socket-wait$wait $BENCH --records $REC --out $CSV --label socket-cuda-wait${wait}ms --socket $SOCK --modes host,e2e 2>> $OUT/log.txt
  kill $SERVER; wait $SERVER 2>/dev/null
done
quiet
log "H0 BENCH DONE"
