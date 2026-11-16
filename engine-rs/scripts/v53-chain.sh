#!/usr/bin/env bash
# Round 6 driver (preregistered 2026-11-15 13:40, "round 6" entry). Self-driving; sentinels "R6 CAL DONE",
# "R6 S2 DONE", "R6 S3 DONE", "R6 ULTRA START", "R6 DONE". Binary tmp/v53/bin (engine 6f63202).
set -u
cd "$(dirname "$0")/../.."
R=tmp/v53; BIN=$R/bin; C=$R/cal
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
before() { [ "$(date +%H%M)" -lt "$1" ]; }
bp() {  # bp <config> <out> <mode> <level> <seeds> <seed-base> <threads> [extra...]
  local cfg=$1 out=$2 mode=$3 lvl=$4 n=$5 sb=$6 th=$7; shift 7
  echo "=== $(basename $out .jsonl) start $(date '+%F %T')"
  "$BIN/blokee-pentobi" --blokee "$cfg" --pentobi "$PENTOBI" --book "$BOOK" --mode "$mode" --gtp-processes per-seat \
    --level "$lvl" --budget 300 --threads "$th" --seeds "$n" --seed-base "$sb" --label "$(basename $out .jsonl)" \
    --out "$out" --moves-out "${out%.jsonl}.moves.jsonl" "$@" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror" || true
  echo "=== $(basename $out .jsonl) done $(date '+%F %T')"
}
BASE=engine-rs/configs/v5.1-ultra.json
echo "R6 start $(date '+%F %T'); $(sed -n 2p $BIN/PROVENANCE.txt)"
# ---------------- Stage 1: Pentobi levels (one game thread each; level 9 alongside the others)
bp $BASE $C/L9.jsonl one-blokee 9 1 96900009 1 --rotations 1 --pentobi-log $C/logs-L9 &
L9PID=$!
for k in 1 2 3 4 5 6 7; do bp $BASE $C/L$k.jsonl one-blokee $k 1 $((96900000 + k)) 1 --pentobi-log $C/logs-L$k; done
bp $BASE $C/L8.jsonl one-blokee 8 1 96900008 1 --rotations 2 --pentobi-log $C/logs-L8
wait $L9PID
python3 engine-rs/scripts/v53_report.py --cal $C > $C/cal.md 2>&1; cat $C/cal.md
python3 - <<'PY'
import json
s = json.load(open("tmp/v53/cal/scales.json"))["scales"]
b = json.load(open("engine-rs/configs/v5.1-ultra.json"))
for t, v in s.items():
    c = json.loads(json.dumps(b)); c["search"]["iterationScale"] = v
    json.dump(c, open(f"tmp/v53/configs/v5.2-{t}.json", "w"), indent=1)
    json.dump(c, open(f"tmp/v53/cal/check-{t}.config.json", "w"), indent=1)
print(s)
PY
# checks: ultra (one game vs level 9) alongside the others
bp $C/check-ultra.config.json $C/check-ultra.jsonl one-blokee 9 1 96950009 1 --rotations 1 &
UPID=$!
bp $C/check-nano.config.json $C/check-nano.jsonl one-blokee 1 1 96950001 1
bp $C/check-lite.config.json $C/check-lite.jsonl one-blokee 3 1 96950003 1
bp $C/check-base.config.json $C/check-base.jsonl one-blokee 5 1 96950005 1
bp $C/check-pro.config.json $C/check-pro.jsonl one-blokee 7 1 96950007 1 --rotations 2
wait $UPID
python3 - <<'PY'
import json, sys
sys.path.insert(0, "engine-rs/scripts")
from v53_report import times
for t in ("nano", "lite", "base", "pro", "ultra"):
    b4, _, p4, _, _, _ = times(f"tmp/v53/cal/check-{t}.timing.jsonl")
    r = b4 / p4
    c = json.load(open(f"tmp/v53/configs/v5.2-{t}.json"))
    if not 0.97 <= r <= 1.03:
        old = c["search"]["iterationScale"]; c["search"]["iterationScale"] = round(old / r, 3)
        json.dump(c, open(f"tmp/v53/configs/v5.2-{t}.json", "w"), indent=1)
        print(f"{t}: check ratio {r:.3f} -> corrected iterationScale {old} -> {c['search']['iterationScale']} (not re-checked)")
    else:
        print(f"{t}: check ratio {r:.3f} inside [0.97, 1.03]; iterationScale {c['search']['iterationScale']}")
PY
python3 engine-rs/scripts/v53_report.py --cal $C > $C/cal.md 2>&1
# base tier saved as plain v5.2 (named 2026-11-16 by Paul; it was v5.2-base.json when this ran)
for t in nano lite base pro ultra; do n=v5.2-$t; [ $t = base ] && n=v5.2; cp $R/configs/v5.2-$t.json engine-rs/configs/$n.json; done
cp tmp/v52/S1/configs/TM.json engine-rs/configs/v5.2-l6.json
echo "R6 CAL DONE $(date '+%F %T')"
# ---------------- Stage 2
G=engine-rs/configs
bp $G/v5.2-nano.json $R/S2/nano-L1.jsonl one-blokee 1 400 96000000 10
bp $G/v5.2-lite.json $R/S2/lite-L3.jsonl one-blokee 3 400 96100000 10
bp $G/v5.2.json $R/S2/base-L5.jsonl one-blokee 5 400 96200000 10
bp $G/v5.2-nano.json $R/S2/rev-nano-L1.jsonl one-pentobi 1 200 96300000 10
bp $G/v5.2-lite.json $R/S2/rev-lite-L3.jsonl one-pentobi 3 200 96400000 10
bp $G/v5.2.json $R/S2/rev-base-L5.jsonl one-pentobi 5 200 96500000 10
before 1630 && bp $G/v5.2-pro.json $R/S2/pro-L7.jsonl one-blokee 7 100 96600000 10
python3 engine-rs/scripts/v53_report.py --tiers $R > $R/S2/tiers.md 2>&1
echo "R6 S2 DONE $(date '+%F %T')"
# ---------------- Stage 3 (each block only if started before 16:55)
i=0
for k in 1 2 3 4 5; do
  for dir in up down; do
    if [ $dir = up ]; then lone=$((k + 1)); three=$k; else lone=$k; three=$((k + 1)); fi
    before 1655 && bp $BASE $R/S3/ladder-L$lone-vs-L$three.jsonl pentobi-ladder $three 200 $((97000000 + 50000 * i)) 10 --lone-level $lone
    i=$((i + 1))
  done
done
before 1655 && bp $G/v5.2-nano.json $R/S3/nano-vs-L2.jsonl one-blokee 2 200 97600000 10
before 1655 && bp $G/v5.2-lite.json $R/S3/lite-vs-L2.jsonl one-blokee 2 200 97700000 10
before 1655 && bp $G/v5.2-lite.json $R/S3/lite-vs-L4.jsonl one-blokee 4 200 97800000 10
before 1655 && bp $G/v5.2.json $R/S3/base-vs-L4.jsonl one-blokee 4 200 97900000 10
before 1655 && bp $G/v5.2.json $R/S3/base-vs-L6.jsonl one-blokee 6 200 97950000 10
python3 engine-rs/scripts/v53_report.py --bench $R > $R/S3/bench.md 2>&1
echo "R6 S3 DONE $(date '+%F %T')"
# ---------------- ultra tail (24 seeds, 3 game threads: about 8 GB per ultra search)
if before 1730; then
  echo "R6 ULTRA START $(date '+%F %T')"
  bp $G/v5.2-ultra.json $R/S2/ultra-L9.jsonl one-blokee 9 24 96700000 3
fi
python3 engine-rs/scripts/v53_report.py --tiers $R > $R/S2/tiers.md 2>&1
echo "R6 DONE $(date '+%F %T')"
