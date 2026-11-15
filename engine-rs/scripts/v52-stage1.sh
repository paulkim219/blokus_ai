#!/usr/bin/env bash
# Round 5, Stage 1 (preregistered 2026-11-15 00:05, "round 5, Stage 1" entry): equal wall time.
# Waits for the round-4 driver (tmp/v51d/S2/chain2.pid). Then, quiet machine, one game thread, per-seat:
#   clean timing of v5.1-ultra: round 1 seeds 93,950,000-004, round 2 93,950,005-009 (40 games)
#   time-matched iterationScale (v52_report.py --tm-scale), check round on 93,950,000-004 (20 games),
#   one correction if Blokee/Pentobi mean ms is outside [0.97, 1.03]
# then 10 threads, per-seat: base and TM on 400 seeds 93,000,000 then 93,100,000; compute curve x1, x2
# (unless round 4 played it), x4 on 200 seeds 93,200,000; one level-6 seat vs three TM, 200 seeds 93,250,000.
# Binary tmp/v51d/bin3 (per-seat seeding). No block starts at or after 08:15. Sentinel "R5S1 DONE".
set -u
cd "$(dirname "$0")/../.."
R=tmp/v52/S1; BIN=tmp/v51d/bin3; THREADS=10
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
ok() { h=$(date +%H%M); [ "$h" -lt 0815 ] || [ "$h" -ge 1200 ]; }
play() {  # play <config> <out> <seeds> <base> <mode> <threads>
  ok || { echo "=== $(basename $2 .jsonl) NOT STARTED (08:15)"; return; }
  echo "=== $(basename $2 .jsonl) start $(date '+%F %T')"
  "$BIN/blokee-pentobi" --blokee "$1" --pentobi "$PENTOBI" --book "$BOOK" --mode "$5" --gtp-processes per-seat \
    --level 6 --budget 300 --threads "$6" --seeds "$3" --seed-base "$4" --label "$(basename $2 .jsonl)" \
    --out "$2" --moves-out "${2%.jsonl}.moves.jsonl" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror" || true
  echo "=== $(basename $2 .jsonl) done $(date '+%F %T')"
}
w=$(cat tmp/v51d/S2/chain2.pid)
echo "R5S1 waiting for round 4 ($w) $(date '+%F %T')"
while kill -0 "$w" 2>/dev/null; do sleep 20; done
echo "R5S1 start $(date '+%F %T'); $(sed -n 2p $BIN/PROVENANCE.txt)"
mkdir -p $R/time $R/configs $R/e1 $R/e2 $R/curve
cp engine-rs/configs/v5.1-ultra.json $R/configs/base.json
echo "clean timing start $(date '+%F %T') load $(uptime | sed 's/.*averages*: //')"
play $R/configs/base.json $R/time/t1.jsonl 5 93950000 one-blokee 1
play $R/configs/base.json $R/time/t2.jsonl 5 93950005 one-blokee 1
python3 engine-rs/scripts/v52_report.py --time $R/time/t1.timing.jsonl | tee $R/time/t1.txt
python3 engine-rs/scripts/v52_report.py --time $R/time/t2.timing.jsonl | tee $R/time/t2.txt
python3 engine-rs/scripts/v52_report.py --time $R/time/t1.timing.jsonl $R/time/t2.timing.jsonl | tee $R/time/both.txt
scale=$(python3 engine-rs/scripts/v52_report.py --tm-scale 14.224 $R/time/t1.timing.jsonl $R/time/t2.timing.jsonl 2> $R/time/tm.log)
cat $R/time/tm.log
python3 - "$scale" <<'PY'
import json, sys
c = json.load(open("tmp/v52/S1/configs/base.json")); c["search"]["iterationScale"] = float(sys.argv[1])
json.dump(c, open("tmp/v52/S1/configs/TM.json", "w"), indent=1)
PY
echo "TM iterationScale $scale"
play $R/configs/TM.json $R/time/check.jsonl 5 93950000 one-blokee 1
python3 engine-rs/scripts/v52_report.py --time $R/time/check.timing.jsonl | tee $R/time/check.txt
ratio=$(sed -n 's/.*ratio \([0-9.]*\).*/\1/p' $R/time/check.txt)
if python3 -c "import sys; sys.exit(0 if 0.97 <= float('$ratio') <= 1.03 else 1)"; then
  echo "check ratio $ratio inside [0.97, 1.03]"
else
  python3 - "$ratio" <<'PY'
import json, sys
p = "tmp/v52/S1/configs/TM.json"; c = json.load(open(p)); old = c["search"]["iterationScale"]
c["search"]["iterationScale"] = round(old / float(sys.argv[1]), 3); json.dump(c, open(p, "w"), indent=1)
print(f"corrected TM iterationScale {old} -> {c['search']['iterationScale']}")
PY
fi
echo "clean timing done $(date '+%F %T')"
for blk in e1:93000000 e2:93100000; do
  b=${blk%%:*}; s=${blk##*:}
  for c in base TM; do
    play $R/configs/$c.json $R/$b/lone-$c.jsonl 400 $s one-blokee $THREADS
  done
done
python3 - <<'PY'
import json
c = json.load(open("tmp/v52/S1/configs/base.json"))
for m in (2, 4):
    d = json.loads(json.dumps(c)); d["search"]["iterationScale"] = round(14.224 * m, 3)
    json.dump(d, open(f"tmp/v52/S1/configs/x{m}.json", "w"), indent=1)
PY
cp $R/configs/base.json $R/configs/x1.json
r4x2=0; [ -f tmp/v51d/S3/v51d-D-x2.jsonl ] && [ "$(wc -l < tmp/v51d/S3/v51d-D-x2.jsonl)" -ge 800 ] && r4x2=1
for m in x1 x2 x4; do
  if [ $m = x2 ] && [ $r4x2 = 1 ]; then echo "x2 measured in round 4 (91,800,000): not replayed"; continue; fi
  play $R/configs/$m.json $R/curve/$m.jsonl 200 93200000 one-blokee $THREADS
done
play $R/configs/TM.json $R/rev-TM.jsonl 200 93250000 one-pentobi $THREADS
python3 engine-rs/scripts/v52_report.py --stage1 $R > $R/stage1.md 2>&1
cat $R/stage1.md
echo "R5S1 DONE $(date '+%F %T')"
