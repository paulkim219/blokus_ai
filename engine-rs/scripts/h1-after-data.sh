#!/usr/bin/env bash
# Hybrid H1, everything after the corpus (prereg `d39275e`, research_paper/v5_hybrid_preregistered.md "H1"):
# conversion and checks, caches, training of arms A and B with the preregistered selection, ONNX export,
# offline gates G1/G1b/G2/G3, engine parity E1, the weight-0 network check E3, and the read-out
# (tmp/h1/SUMMARY.txt and the results section of research_paper/v5_hybrid_results.md, committed locally).
#
# Run on the PC from the repo root, in tmux:   bash engine-rs/scripts/h1-after-data.sh
# It waits for the corpus (tmp/h1/data/L8.done, or "DATA DONE" in tmp/h1/data/log.txt) and for the data
# processes to exit, so it can be started at any time. Resumable: every step leaves <after>/<step>.done and is
# skipped on a rerun; training checkpoints after every validation and continues from it. After a Windows
# restart, just run the same command again (docs/HYBRID_PC_RUNBOOK.md).
#
# DRY=1: a dry run of the CPU-only steps on the pilot data under tmp/h1/dry (no build, no GPU, no commit).
set -u
cd "$(git rev-parse --show-toplevel)"
P=ml/.venv-hybrid/bin/python
D=tmp/h1/data
if [ -n "${DRY:-}" ]; then
  ROOT=tmp/h1/dry
  TURBO_RUNS="tmp/h1/pilot/turbo"; PRO_RUNS="tmp/h1/pilot/pro"
  L7_MOVES="tmp/h1/pilot/L7.moves.jsonl"; L8_MOVES="tmp/h1/pilot/L8.moves.jsonl"
else
  ROOT=tmp/h1
  # Every preregistered seed of each source: the pilot block and the main block. The turbo main block came
  # out in three directories after the 2026-11-23 PC restart (tmp/h1/resume-data.sh): turbo (game indices
  # 0..15876 except 15875), turbo-b (15877..21999) and turbo-c (15875).
  TURBO_RUNS="tmp/h1/pilot/turbo $D/turbo $D/turbo-b $D/turbo-c"; PRO_RUNS="tmp/h1/pilot/pro $D/pro"
  L7_MOVES="tmp/h1/pilot/L7.moves.jsonl $D/L7.moves.jsonl"; L8_MOVES="tmp/h1/pilot/L8.moves.jsonl $D/L8.moves.jsonl"
fi
A=$ROOT/after; C=$ROOT/cache; T=$ROOT/train; O=$ROOT/onnx
mkdir -p $A $C $T $O
SUMMARY=$ROOT/SUMMARY.txt
log() { echo "$(date '+%F %T') $*" | tee -a $A/chain.log; }
fail() { log "FAILED at step $1 (see $A/$1.log); rerun the same command after fixing"; echo "H1 chain FAILED at step $1 at $(date '+%F %T'); log $A/$1.log" > $SUMMARY; exit 1; }
step() { # name, command... : skipped if done; output to <after>/<name>.log
  local name=$1; shift
  if [ -f $A/$name.done ]; then return 0; fi
  log "step $name: start"
  local t0=$(date +%s)
  if "$@" >> $A/$name.log 2>&1; then touch $A/$name.done; log "step $name: done in $(( ($(date +%s) - t0) / 60 )) min"
  else fail $name; fi
}

# 0. Wait for the corpus and for the machine to be free of data processes.
if [ -z "${DRY:-}" ]; then
  until [ -f $D/L8.done ] || grep -q "DATA DONE" $D/log.txt 2>/dev/null; do sleep 300; done
  while pgrep -f "tmp/h1/bin-data/blokee-(selfplay|pentobi)" > /dev/null; do sleep 60; done
  [ -f $D/L8.done ] || log "NOTE: L8.done is missing (blokee-pentobi reported failures; see $D/L8.failures.jsonl); continuing with the games written"
fi
log "chain start ($(git rev-parse --short HEAD))"
echo "H1 chain running since $(date '+%F %T'); progress in $A/chain.log" > $SUMMARY

build() {
  source $HOME/.cargo/env && source engine-rs/scripts/h0-env.sh &&
  (cd engine-rs && cargo build --release --bins --examples && CARGO_TARGET_DIR=target-ort cargo build --release --features ort --bins --examples)
}
[ -z "${DRY:-}" ] && step build build

# 1. Pentobi moves to v3 records (pilot and main blocks in one run each).
convert() { rm -rf $ROOT/$1-v3; tmp/h1/bin-data/h1_moves_v3 $ROOT/$1-v3 $2 ${@:3}; }
step convert-L7 convert L7 7 $L7_MOVES
step convert-L8 convert L8 8 $L8_MOVES

# 2. Record checks (exit code 1 on any problem stops the chain).
step check $P ml/torch/h1_check_v3.py $TURBO_RUNS $PRO_RUNS $ROOT/L7-v3 $ROOT/L8-v3 --json $A/check.json

# 3. Caches.
cache() { rm -rf $C/$1; $P ml/torch/h1_data.py build --out $C/$1 --kind $2 --runs ${@:3}; }
step cache-turbo cache turbo selfplay $TURBO_RUNS
step cache-pro cache pro selfplay $PRO_RUNS
step cache-L7 cache L7 teacher $ROOT/L7-v3
step cache-L8 cache L8 teacher $ROOT/L8-v3
if [ -z "${DRY:-}" ] && [ ! -f $C/old/meta.json ]; then
  R=$HOME/Blokee/ml/data
  step cache-old cache old old $R/selfplay-v41u-300 $(for g in 0 1 2 3 4 5 6 7; do echo $R/expert-iteration/gen-$g; done)
fi

# 4. N11 features of the level-7 test decisions (seed's last digit 9), for the fitted prior in G1b/G2.
n11() {
  mkdir -p $A/n11 && python3 -c "import json,sys
out=open(sys.argv[1],'w')
for f in sys.argv[2:]:
    for l in open(f):
        if l.strip() and json.loads(l)['seed'] % 10 == 9: out.write(l)" $A/n11/L7-test.moves.jsonl $L7_MOVES &&
  engine-rs/target/release/examples/n11_features 8 $A/n11/L7-test $A/n11/L7-test.moves.jsonl
}
step n11 n11

if [ -n "${DRY:-}" ]; then
  $P ml/torch/h1_report.py --root $ROOT --after $A --summary $SUMMARY --results $ROOT/results-dry.md --runs-dir $ROOT/runs > /dev/null
  log "DRY RUN DONE (CPU steps only); summary $SUMMARY"
  exit 0
fi

# 5. GPU checks of the caches: the GPU legal mask against each record's legal count, and against every
#    listed move (as sets) on a run's first shard.
gpu_check() {
  for c in turbo pro L7 L8; do $P ml/torch/h1_data.py check --cache $C/$c || return 1; done
  for r in $D/turbo $D/pro $ROOT/L7-v3 $ROOT/L8-v3; do $P ml/torch/h1_data.py check-raw --run $r --limit 5000 || return 1; done
}
step gpu-check gpu_check

# 6. Training, arms A and B (prereg: 30,000 steps, batch 512, EMA 0.999, lr 1e-3, seed 0; B adds the old corpus at 25%).
NEW="--selfplay $C/turbo $C/pro --teacher $C/L7 $C/L8"
step train-A $P ml/torch/train_v3.py $NEW --steps 30000 --name h1-A --out $T
step train-B $P ml/torch/train_v3.py $NEW --old $C/old --old-share 0.25 --steps 30000 --name h1-B --out $T

# 7. Selection: B only if its best validation loss is lower than A's by at least 0.5%.
select_arm() {
  python3 - $T $A/selection.json <<'PY'
import json, sys
t, out = sys.argv[1], sys.argv[2]
a, b = (json.load(open(f"{t}/h1-{k}.json")) for k in "AB")
pick = "B" if b["bestValLoss"] < a["bestValLoss"] * (1 - 0.005) else "A"
reason = (f"Best validation loss A {a['bestValLoss']:.4f} (step {a['bestStep']}), B {b['bestValLoss']:.4f} (step {b['bestStep']}); "
          f"B is selected only if lower than A's by at least 0.5% (threshold {a['bestValLoss'] * 0.995:.4f}).")
json.dump({"selected": pick, "checkpoint": f"{t}/h1-{pick}.pt", "reason": reason}, open(out, "w"), indent=1)
print(pick, reason)
PY
}
step select select_arm
SEL=$(python3 -c "import json;print(json.load(open('$A/selection.json'))['checkpoint'])")

# 8. ONNX export of the selected network.
step export $P ml/torch/onnx_export_v3.py --checkpoint $SEL --out $O/h1-selected

# 9. Offline gates on the test split.
step gates $P ml/torch/h1_gates.py --checkpoint $SEL --teacher-cache $C/L7 --n11-dump $A/n11/L7-test \
  --selfplay-cache $C/turbo --selfplay-cache2 $C/pro --also-visits-head --out $A/gates.json

# 10. H1-E1 parity: the engine's path (CPU and CUDA, TF32 off) and ONNX Runtime against PyTorch, 20,000 records.
parity() {
  source engine-rs/scripts/h0-env.sh && mkdir -p $A/parity &&
  for dev in cpu cuda; do
    engine-rs/target-ort/release/examples/h1_v3_eval $O/h1-selected.fp32.onnx $dev $D/turbo $A/parity/rust-$dev 20000 > $A/parity/rust-$dev.log 2>&1 || return 1
  done &&
  $P ml/torch/h1_parity.py --checkpoint $SEL --onnx $O/h1-selected --run $D/turbo --limit 20000 \
    --rust $A/parity/rust-cpu $A/parity/rust-cuda --out $A/parity/parity.json
}
step parity parity

# 11. H1-E3: the selected network at rootBlend 0 inside v5.3-turbo plays v5.3-turbo's games.
step noop env ONLY_NOOP=1 V3_MODEL=$O/h1-selected.fp32.onnx bash engine-rs/scripts/h1-identity.sh $A/identity-noop

# 12. Read-out and local commit (never pushed from here).
report() {
  $P ml/torch/h1_report.py --root $ROOT --after $A --summary $SUMMARY --results research_paper/v5_hybrid_results.md \
    --runs-dir research_paper/hybrid_h1_runs &&
  git add research_paper/v5_hybrid_results.md research_paper/hybrid_h1_runs &&
  git commit -q -m "Hybrid H1 results: network v3 training, selection, offline gates, parity (generated on the PC by h1-after-data.sh)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
}
step report report
log "H1 CHAIN DONE; summary $SUMMARY"
