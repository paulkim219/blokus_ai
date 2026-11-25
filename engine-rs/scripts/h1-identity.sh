#!/usr/bin/env bash
# Hybrid H1 gate H1-E2 (research_paper/v5_hybrid_preregistered.md): with the network off and no new flags the
# engine is unchanged. Run on the PC from the repo root after building:
#   NEW  this tree, default features (engine-rs/target/release)
#   ORT  this tree, --features ort, CARGO_TARGET_DIR=engine-rs/target-ort
# against BASE, the parent build kept at ~/Blokee-h0-base (5b57f48; H0 showed hybrid-h0 identical to it).
# usage: engine-rs/scripts/h1-identity.sh [out-dir]
set -u
OUT=${1:-tmp/h1/identity}; mkdir -p $OUT
BASE_TREE=${BASE_TREE:-$HOME/Blokee-h0-base}
log() { echo "$(date '+%F %T') $*" | tee -a $OUT/log.txt; }

E=engine-rs/configs
# ONLY_NOOP=1 V3_MODEL=<onnx>: only the network-at-weight-0 check (H1-E3) below.
if [ -z "${ONLY_NOOP:-}" ]; then
# H0's whole identity suite (self-play shards, blokee-match games, s4_identity dumps, mirrors), unchanged.
bash engine-rs/scripts/h0-identity.sh $OUT
cat $OUT/log.txt | grep -c FAIL | xargs -I{} echo "h0 suite FAIL lines: {}" | tee -a $OUT/log.txt

E=engine-rs/configs
for b in new ort; do
  BIN=engine-rs/target/release; [ $b = ort ] && BIN=engine-rs/target-ort/release
  for cfg in v4.2-ultra v5.3-turbo; do
    # --format v2 spelled out equals the default.
    rm -rf $OUT/v2x-$b-$cfg $OUT/v3-$b-$cfg
    $BIN/blokee-selfplay --config $E/$cfg.json --games 4 --budget 300 --threads 1 --seed-base 80950000 --format v2 \
      --out $OUT/v2x-$b-$cfg > /dev/null 2>&1 || log "selfplay --format v2 $b $cfg FAILED"
    for f in shard-00.bin games.jsonl meta.json; do
      if cmp -s $OUT/sp-base-$cfg/$f $OUT/v2x-$b-$cfg/$f; then log "H1 --format v2 $b $cfg $f: identical to base"
      else log "H1 --format v2 $b $cfg $f: differs from base  FAIL"; fi
    done
    # --format v3 plays the same games (scores and iterations per game equal to the v2 run).
    $BIN/blokee-selfplay --config $E/$cfg.json --games 4 --budget 300 --threads 1 --seed-base 80950000 --format v3 \
      --out $OUT/v3-$b-$cfg > /dev/null 2>&1 || log "selfplay --format v3 $b $cfg FAILED"
    if python3 -c "import json,sys
a=[json.loads(l) for l in open(sys.argv[1])]; b=[json.loads(l) for l in open(sys.argv[2])]
sys.exit(0 if [(x['game'],x['scores'],x['iterations']) for x in a]==[(x['game'],x['scores'],x['iterations']) for x in b] else 1)" \
      $OUT/sp-base-$cfg/games.jsonl $OUT/v3-$b-$cfg/games.jsonl; then log "H1 --format v3 $b $cfg: same games as base (scores, iterations)"
    else log "H1 --format v3 $b $cfg: different games  FAIL"; fi
  done
done

# blokee-pentobi (not in H0's suite): one-blokee at level 1, 1 seed x 4 rotations, every field but timing.
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
for b in base new ort; do
  BIN=engine-rs/target/release; [ $b = ort ] && BIN=engine-rs/target-ort/release; [ $b = base ] && BIN=$BASE_TREE/engine-rs/target/release
  rm -f $OUT/pentobi-$b.jsonl $OUT/pentobi-$b.timing.jsonl $OUT/pentobi-$b.moves.jsonl
  $BIN/blokee-pentobi --blokee $E/v5.3-turbo.json --pentobi $PENTOBI --book $BOOK --level 1 --mode one-blokee \
    --gtp-processes per-seat --seeds 1 --seed-base 80960000 --budget 300 --threads 1 --label h1-id \
    --out $OUT/pentobi-$b.jsonl --moves-out $OUT/pentobi-$b.moves.jsonl > /dev/null 2>&1 || log "pentobi $b FAILED"
  python3 -c "import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l); d.pop('challengerSeconds',None); print(json.dumps(d,sort_keys=True))" $OUT/pentobi-$b.jsonl | sort > $OUT/pentobi-$b.cmp
  sort $OUT/pentobi-$b.moves.jsonl > $OUT/pentobi-$b.moves.cmp
done
for b in new ort; do
  if cmp -s $OUT/pentobi-base.cmp $OUT/pentobi-$b.cmp && cmp -s $OUT/pentobi-base.moves.cmp $OUT/pentobi-$b.moves.cmp; then
    log "H1 blokee-pentobi one-blokee L1: base == $b ($(wc -l < $OUT/pentobi-$b.cmp) games, results and moves)"
  else log "H1 blokee-pentobi one-blokee L1: base != $b  FAIL"; fi
done

fi  # ONLY_NOOP

# Network on, weight 0: a v3 network at rootBlend 0 (interiorVisits 0) inside v5.3-turbo is called once per
# searched move but changes no prior, so it must play exactly v5.3-turbo's games (ort build, CUDA).
if [ -n "${V3_MODEL:-}" ]; then
  python3 - "$V3_MODEL" $OUT/noop.json <<'PY'
import json, sys
c = json.load(open("engine-rs/configs/v5.3-turbo.json"))
c["native"]["net"] = {"evaluator": {"backend": "ort", "model": sys.argv[1], "device": "cuda", "format": "v3", "head": "teacher"},
                      "rootBlend": 0.0, "temperature": 1.0}
json.dump(c, open(sys.argv[2], "w"), indent=1)
PY
  ( source engine-rs/scripts/h0-env.sh
    for arm in noop plain; do
      CH=$OUT/noop.json; [ $arm = plain ] && CH=$E/v5.3-turbo.json
      rm -f $OUT/noop-$arm.jsonl
      engine-rs/target-ort/release/blokee-match --challenger $CH --champion $E/v5.3-turbo.json --seeds 4 --seed-base 80960000 \
        --budget 300 --threads 4 --label h1-noop --out $OUT/noop-$arm.jsonl > /dev/null 2>&1 || echo "noop $arm FAILED" >> $OUT/log.txt
      python3 -c "import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l); [d.pop(k,None) for k in ('challengerSeconds','challenger','challengerNetEvals')]; print(json.dumps(d,sort_keys=True))" $OUT/noop-$arm.jsonl | sort > $OUT/noop-$arm.cmp
    done )
  if cmp -s $OUT/noop-noop.cmp $OUT/noop-plain.cmp; then log "H1 v3 network at weight 0 inside v5.3-turbo: same $(wc -l < $OUT/noop-plain.cmp) games as v5.3-turbo"
  else log "H1 v3 network at weight 0: games differ  FAIL"; fi
fi

[ -n "${ONLY_NOOP:-}" ] && { log "H1 NOOP DONE"; exit 0; }
# Parity tests in both builds (G3a of H0, now with the record-v3 and net_v3 unit tests).
[ -f $HOME/.cargo/env ] && source $HOME/.cargo/env
for b in new ort; do
  if [ $b = ort ]; then T=$( (cd engine-rs && CARGO_TARGET_DIR=target-ort cargo test --release --features ort 2>&1) | grep -E "^test result" )
  else T=$( (cd engine-rs && cargo test --release 2>&1) | grep -E "^test result" ); fi
  P=$(echo "$T" | awk '{s+=$4} END {print s}'); F=$(echo "$T" | awk '{s+=$6} END {print s}')
  log "H1 cargo test --release ($b): $P passed, $F failed"
done
log "H1 IDENTITY DONE"
