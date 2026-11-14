#!/usr/bin/env bash
# Stage C (S6: second speed pass, re-timed base) and Stage D (benchmark of the final base), run after
# pkg-master.sh finishes. Preregistered 2026-11-14 ("S6" and "X4" entries in
# research_paper/v6_native_and_learning_preregistered.md).
#
#   nohup engine-rs/scripts/s6d-post.sh <pkg-master pid> > tmp/s6/post.log 2>&1 &   # then caffeinate -w
#
# Sentinels: "S6 COST DONE", "S6 CONFIRM DONE", "X4 <label> DONE", "POST DONE".
set -u
cd "$(dirname "$0")/../.."
WAITPID=${1:-}
OLD=tmp/s6/bin-before      # the Stage-A pin (engine 18e9149)
NEW=tmp/s6/bin             # S6 engine (ad66afb)
PENTOBI=${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}
BOOK=${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}
THREADS=10
CUTOFF=${CUTOFF:-0815}     # start no match block at or after this time (HHMM, CST)
load() { uptime | sed 's/.*load averages*: //'; }
late() { [ "$(date +%H%M)" -ge "$CUTOFF" ] && [ "$(date +%H)" -lt 12 ]; }

if [ -n "$WAITPID" ]; then
  echo "waiting for pid $WAITPID ($(date '+%F %T'))"
  while kill -0 "$WAITPID" 2>/dev/null; do sleep 30; done
fi
echo "POST start $(date '+%F %T') load: $(load)"
# The base after Stages A and B.
BASE=$(cat tmp/pkg/FINAL_BASE)
if grep -q "^NEW BASE: IIV1" tmp/iiv/rep.md 2>/dev/null; then BASE=engine-rs/configs/v5.0-iiv1-ultra.json; fi
echo "base for S6: $BASE"
echo "$BASE" > tmp/s6/BASE
mkdir -p tmp/s6/cost tmp/s6/configs tmp/s6/confirm tmp/s6/identity
cp "$BASE" tmp/s6/configs/base.json

# 1. Identity of the final base through both binaries (300 positions, complete search output).
F=tmp/d1/x1-l6a.moves.jsonl,tmp/x3/x3-l7-p4i.moves.jsonl
"$OLD/s4_identity" tmp/s6/identity/base-before.txt 150 10 $F tmp/s6/configs/base.json 2>/dev/null
"$NEW/s4_identity" tmp/s6/identity/base-after.txt 150 10 $F tmp/s6/configs/base.json 2>/dev/null
if cmp -s tmp/s6/identity/base-before.txt tmp/s6/identity/base-after.txt; then
  echo "S6 identity on the final base: byte-identical ($(wc -l < tmp/s6/identity/base-after.txt) searches)"
  SAME=1
else
  echo "S6 identity on the final base: DIFFERS -> no re-timing, Stage C stops"
  SAME=0
fi

# 2. Clean cost, old vs new binary, rounds alternating (nothing else of ours runs now).
ratio=nan
if [ $SAME = 1 ]; then
  echo "=== cost start $(date '+%F %T') load: $(load)"
  for round in 1 2; do
    for side in before after; do
      bin=$OLD; [ $side = after ] && bin=$NEW
      "$bin/p4_cost" tmp/d1/x1-l6a.moves.jsonl 150 2 tmp/s6/cost/cost-$side-$round.csv tmp/s6/configs/base.json 2>/dev/null
      echo "round $round $side $(date '+%T') load: $(load)"
    done
  done
  ratio=$(python3 - <<'EOF'
import csv, glob
def m(side):
    v = []
    for f in sorted(glob.glob(f"tmp/s6/cost/cost-{side}-*.csv")):
        v += [float(r["ms"]) for r in csv.DictReader(open(f)) if int(r["own_idx"]) >= 3]
    return sum(v) / len(v)
print(f"{m('after') / m('before'):.4f}")
EOF
)
  echo "S6 COST DONE $(date '+%F %T'): clean ms/move new / old on the base = $ratio"
fi
echo "$ratio" > tmp/s6/COST_RATIO
retimed=0
if [ $SAME = 1 ] && python3 -c "import sys; sys.exit(0 if float('$ratio') <= 0.90 else 1)"; then
  # 3. Re-time: iterationScale x (1 / ratio), one check, at most one correction (prereg).
  python3 - "$ratio" <<'EOF'
import json, sys
c = json.load(open("tmp/s6/configs/base.json"))
s = c["search"]["iterationScale"]
c["search"]["iterationScale"] = round(s / float(sys.argv[1]), 3)
json.dump(c, open("tmp/s6/configs/S6T.json", "w"), indent=1)
print("S6T iterationScale", s, "->", c["search"]["iterationScale"])
EOF
  for attempt in 1 2; do
    for round in 1 2; do
      "$OLD/p4_cost" tmp/d1/x1-l6a.moves.jsonl 150 2 tmp/s6/cost/check$attempt-old-$round.csv tmp/s6/configs/base.json 2>/dev/null
      "$NEW/p4_cost" tmp/d1/x1-l6a.moves.jsonl 150 2 tmp/s6/cost/check$attempt-new-$round.csv tmp/s6/configs/S6T.json 2>/dev/null
    done
    check=$(python3 - $attempt <<'EOF'
import csv, glob, sys
a = sys.argv[1]
def m(side):
    v = []
    for f in sorted(glob.glob(f"tmp/s6/cost/check{a}-{side}-*.csv")):
        v += [float(r["ms"]) for r in csv.DictReader(open(f)) if int(r["own_idx"]) >= 3]
    return sum(v) / len(v)
print(f"{m('new') / m('old'):.4f}")
EOF
)
    echo "check $attempt: S6T on the new binary / base on the old binary = $check"
    echo "$check" > tmp/s6/CHECK_$attempt
    if python3 -c "import sys; sys.exit(0 if 0.97 <= float('$check') <= 1.03 else 1)" || [ $attempt = 2 ]; then break; fi
    python3 - "$check" <<'EOF'
import json, sys
c = json.load(open("tmp/s6/configs/S6T.json"))
s = c["search"]["iterationScale"]
c["search"]["iterationScale"] = round(s / float(sys.argv[1]), 3)
json.dump(c, open("tmp/s6/configs/S6T.json", "w"), indent=1)
print("S6T corrected iterationScale", s, "->", c["search"]["iterationScale"])
EOF
  done
  retimed=1
  # 4. Confirmation: base and S6T on the new binary, started together, 400 seeds from 88,400,000.
  if late; then
    echo "past the cut-off: S6 confirmation not started"
  else
    echo "S6 confirmation start $(date '+%F %T') load: $(load)"
    for arm in base S6T; do
      "$NEW/blokee-pentobi" --blokee tmp/s6/configs/$arm.json --pentobi "$PENTOBI" --book "$BOOK" \
        --mode one-blokee --level 6 --budget 300 --threads 5 --seeds 400 --seed-base 88400000 \
        --label s6c-$arm --out tmp/s6/confirm/s6c-$arm.jsonl --moves-out tmp/s6/confirm/s6c-$arm.moves.jsonl \
        2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror" &
    done
    wait
    python3 engine-rs/scripts/s4_report.py --arms tmp/s6/confirm s6c base S6T | tee tmp/s6/confirm.md
    python3 - <<'EOF' | tee -a tmp/s6/confirm.md
import os, sys
sys.path.insert(0, "engine-rs/scripts")
from p910_report import paired_lines
a, f, n = paired_lines("tmp/s6/confirm/s6c-S6T.jsonl", "tmp/s6/confirm/s6c-base.jsonl")
ok = a[1] > 0 and not (f[2] < 0)
print(f"- S6T: paired {a[0]:+.2f} [{a[1]:+.2f}, {a[2]:+.2f}] on {n} seeds; first place {f[0]:+.2f} pp [{f[1]:+.2f}, {f[2]:+.2f}]")
print(f"VERDICT: {'ACCEPTED' if ok else 'NOT ACCEPTED'}")
EOF
    if grep -q "^VERDICT: ACCEPTED" tmp/s6/confirm.md; then
      cp tmp/s6/configs/S6T.json engine-rs/configs/v5.0-s6-ultra.json
      BASE=engine-rs/configs/v5.0-s6-ultra.json
    fi
    echo "S6 CONFIRM DONE $(date '+%F %T')"
  fi
else
  echo "S6: no re-timing (identity $SAME, ratio $ratio > 0.90 or not measured)"
fi

# 5. X4 benchmark of the final base (descriptive): level 7, level 5, reverse; 200 seeds each.
echo "$BASE" > tmp/s6/X4_BASE
mkdir -p tmp/x4
for spec in "x4-l7:one-blokee:7:88600000" "x4-l5:one-blokee:5:88500000" "x4-rev:one-pentobi:6:88700000"; do
  IFS=: read -r label mode level seed <<< "$spec"
  if late; then echo "past the cut-off: $label not started"; continue; fi
  echo "=== $label start $(date '+%F %T') load: $(load)"
  "$NEW/blokee-pentobi" --blokee "$BASE" --blokee-name "$(basename "$BASE" .json)" --pentobi "$PENTOBI" --book "$BOOK" \
    --mode "$mode" --level "$level" --budget 300 --threads $THREADS --seeds 200 --seed-base "$seed" \
    --label "$label" --out tmp/x4/$label.jsonl --moves-out tmp/x4/$label.moves.jsonl \
    2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror"
  { echo "=== $label ($(date '+%F %T'))"; npx tsx scripts/aggregateMatches.ts tmp/x4/$label.jsonl; echo; } >> tmp/x4/summary.txt 2>&1
  echo "X4 $label DONE $(date '+%F %T')"
done
echo "POST DONE $(date '+%F %T')"
