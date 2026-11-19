#!/usr/bin/env bash
# Hybrid H0 gate G3 (research_paper/v5_hybrid_preregistered.md): with no new config keys the engine is
# unchanged. Run on the PC from the repo root after building three binaries:
#   BASE  parent commit 5b57f48 (a worktree at $BASE_TREE), cargo build --release --bins --examples
#   NEW   this tree, default features
#   ORT   this tree, --features ort, CARGO_TARGET_DIR=engine-rs/target-ort
# usage: engine-rs/scripts/h0-identity.sh [out-dir]       (one thread for everything compared)
set -u
OUT=${1:-tmp/h0/identity}; mkdir -p $OUT
BASE_TREE=${BASE_TREE:-$HOME/Blokee-h0-base}
declare -A BIN=([base]=$BASE_TREE/engine-rs/target/release [new]=engine-rs/target/release [ort]=engine-rs/target-ort/release)
E=engine-rs/configs; POS=${POS:-tmp/h0/x1-l6a.moves.jsonl}
export PATH=$HOME/.local/bin:$PATH
log() { echo "$(date '+%F %T') $*" | tee -a $OUT/log.txt; }

# G3c-1: self-play, two configs, 4 games each, one thread: shard and games.jsonl must be byte-identical.
for cfg in v4.2-ultra v5.3-turbo; do
  for b in base new ort; do
    rm -rf $OUT/sp-$b-$cfg
    ${BIN[$b]}/blokee-selfplay --config $E/$cfg.json --games 4 --budget 300 --threads 1 --seed-base 80950000 \
      --out $OUT/sp-$b-$cfg > /dev/null 2>&1 || log "selfplay $b $cfg FAILED"
  done
  for b in new ort; do
    for f in shard-00.bin games.jsonl; do
      if cmp -s $OUT/sp-base-$cfg/$f $OUT/sp-$b-$cfg/$f; then
        log "G3c selfplay $cfg $f: base == $b ($(sha256sum < $OUT/sp-$b-$cfg/$f | cut -c1-16), $(stat -c %s $OUT/sp-$b-$cfg/$f) bytes)"
      else
        log "G3c selfplay $cfg $f: base != $b  FAIL"
      fi
    done
  done
done

# G3c-2: blokee-match games, 2 seeds x 4 rotations, one thread; compare every line except the timing field.
for b in base new ort; do
  rm -f $OUT/match-$b.jsonl
  ${BIN[$b]}/blokee-match --challenger $E/v5.3-turbo.json --champion $E/v5.2-turbo.json --seeds 2 --seed-base 80900000 \
    --budget 300 --threads 1 --label h0-id --out $OUT/match-$b.jsonl > /dev/null 2>&1 || log "match $b FAILED"
  python3 -c "import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l); d.pop('challengerSeconds',None); print(json.dumps(d,sort_keys=True))" $OUT/match-$b.jsonl | sort > $OUT/match-$b.cmp
done
for b in new ort; do
  if cmp -s $OUT/match-base.cmp $OUT/match-$b.cmp; then log "G3c match: base == $b ($(wc -l < $OUT/match-$b.cmp) games, all fields but challengerSeconds)"
  else log "G3c match: base != $b  FAIL"; fi
done

# G3c-3: s4_identity dumps (complete root results of eight configs on recorded positions), one thread.
EIGHT="$E/v5.2-nano.json $E/v5.2-lite.json $E/v5.2.json $E/v5.2-turbo.json $E/v5.3-nano.json $E/v5.3-lite.json $E/v5.3.json $E/v5.3-turbo.json"
for b in base new ort; do
  ${BIN[$b]}/examples/s4_identity $OUT/s4-$b.txt ${S4_POSITIONS:-180} 1 $POS $EIGHT 2>/dev/null || log "s4_identity $b FAILED"
done
for b in new ort; do
  if cmp -s $OUT/s4-base.txt $OUT/s4-$b.txt; then log "G3c s4_identity: base == $b ($(wc -l < $OUT/s4-$b.txt) lines, $(sha256sum < $OUT/s4-$b.txt | cut -c1-16))"
  else log "G3c s4_identity: base != $b  FAIL"; fi
done

# G3b: mirror matches with the new binaries must print 0.00 [-0.00, 0.00].
for b in new ort; do
  for spec in "v5.3-turbo 20 8" "v4.2-ultra 4 4"; do
    set -- $spec
    rm -f $OUT/mirror-$b-$1.jsonl
    ${BIN[$b]}/blokee-match --challenger $E/$1.json --champion $E/$1.json --seeds $2 --seed-base 80900000 --budget 300 \
      --threads $3 --label h0-mirror --out $OUT/mirror-$b-$1.jsonl > /dev/null 2>&1 || log "mirror $b $1 FAILED"
    npx tsx scripts/aggregateMatches.ts $OUT/mirror-$b-$1.jsonl > $OUT/mirror-$b-$1.txt 2>&1
    log "G3b mirror $b $1: $(grep -m1 Advantage $OUT/mirror-$b-$1.txt)"
  done
done
log "H0 IDENTITY DONE"
