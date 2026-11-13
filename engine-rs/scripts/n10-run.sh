#!/usr/bin/env bash
# N10 real run, unattended and resumable: liveness (only if the space is not yet fixed), then CEM.
#
#   nohup engine-rs/scripts/n10-run.sh > tmp/n10/chain.log 2>&1 &
#   DEADLINE=07:25 GENERATIONS=40 THREADS=4 nohup engine-rs/scripts/n10-run.sh >> tmp/n10/chain.log 2>&1 &
#
# Rerunning the same line resumes: `live` is skipped once tmp/n10/space.json exists, and `run`
# continues from the last completed generation in tmp/n10/state.json (candidate JSONLs are reused).
# The binary is pinned once in tmp/n10/bin; later runs pass that pinned copy.
# Sentinels in the log: "LIVE DONE", "GEN <g> DONE", "RUN EXIT", "CHAIN EXIT <status>".
set -u
cd "$(dirname "$0")/../.."

START=${START:-engine-rs/configs/v5.0-p4-ultra.json}
SRC_BIN=${SRC_BIN:-tmp/p4/bin/blokee-pentobi}
OUT=${OUT:-tmp/n10}
THREADS=${THREADS:-4}
GENERATIONS=${GENERATIONS:-40}
DEADLINE=${DEADLINE:-07:25}
T=engine-rs/scripts/n10_tune.py

mkdir -p "$OUT"
BIN=$OUT/bin/blokee-pentobi
[ -x "$BIN" ] || BIN=$SRC_BIN
echo "=== chain start $(date '+%F %T') start=$START bin=$BIN threads=$THREADS deadline=$DEADLINE"
if [ ! -f "$OUT/space.json" ]; then
  python3 "$T" live --base "$START" --bin "$BIN" --out "$OUT" --threads "$THREADS" || { echo "CHAIN EXIT live-failed"; exit 1; }
  BIN=$OUT/bin/blokee-pentobi
fi
python3 "$T" run --base "$START" --bin "$OUT/bin/blokee-pentobi" --out "$OUT" --threads "$THREADS" \
  --pop 20 --elite 5 --seeds-per-candidate 10 --generations "$GENERATIONS" --deadline "$DEADLINE"
status=$?
echo "CHAIN EXIT $status $(date '+%F %T')"
