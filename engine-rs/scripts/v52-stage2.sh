#!/usr/bin/env bash
# Round 5, Stage 2 (N20, preregistered 2026-11-15 00:20, "round 5, Stage 2" entry). Waits for the Stage-1
# driver. Clean per-game cost of the four iterationShape arms vs v5.1-ultra (p4_cost, quiet, two rounds);
# an arm outside [0.97, 1.03] has its whole shape (own moves 3+) scaled by 1/ratio once. Screen base + arms,
# per-seat, 400 seeds 93,300,000; best clearing arm confirmed with a fresh base on 400 seeds 93,400,000
# (started together); accepted -> engine-rs/configs/v5.2-cand-ultra.json. Binary tmp/v51d/bin3 (iterationShape
# exists since S5; no engine change). No block at or after 08:15. Sentinel "R5S2 DONE".
set -u
cd "$(dirname "$0")/../.."
R=tmp/v52/S2; BIN=tmp/v51d/bin3; THREADS=10
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
ok() { h=$(date +%H%M); [ "$h" -lt 0815 ] || [ "$h" -ge 1200 ]; }
play() {  # play <config> <out> <seeds> <base> <threads>
  ok || { echo "=== $(basename $2 .jsonl) NOT STARTED (08:15)"; return; }
  echo "=== $(basename $2 .jsonl) start $(date '+%F %T')"
  "$BIN/blokee-pentobi" --blokee "$1" --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --gtp-processes per-seat \
    --level 6 --budget 300 --threads "$5" --seeds "$3" --seed-base "$4" --label "$(basename $2 .jsonl)" \
    --out "$2" --moves-out "${2%.jsonl}.moves.jsonl" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror" || true
  echo "=== $(basename $2 .jsonl) done $(date '+%F %T')"
}
w=$(cat tmp/v52/S1/chain.pid)
echo "R5S2 waiting for Stage 1 ($w) $(date '+%F %T')"
while kill -0 "$w" 2>/dev/null; do sleep 20; done
echo "R5S2 start $(date '+%F %T')"
arms=$(cat $R/ARMS)
BIN=tmp/v51d/bin2 bash engine-rs/scripts/v51b-cost.sh $R screen $arms
python3 engine-rs/scripts/v51_report.py --cost $R screen | tee $R/cost/screen-cost.md
for a in $arms; do
  c=$(python3 -c "import json; print(json.load(open('$R/COSTS'))['$a'])")
  if ! python3 -c "import sys; sys.exit(0 if 0.97 <= float('$c') <= 1.03 else 1)"; then
    python3 - "$a" "$c" <<'PY'
import json, sys
a, c = sys.argv[1], float(sys.argv[2])
p = f"tmp/v52/S2/configs/{a}.json"; cfg = json.load(open(p))
s = cfg["search"]["iterationShape"]; cfg["search"]["iterationShape"] = s[:3] + [round(x / c, 4) for x in s[3:]]
json.dump(cfg, open(p, "w"), indent=1)
m = json.load(open("tmp/v52/S2/manifest.json")); m[a] += f"; whole shape (own moves 3+) scaled by 1/{c:.4f} after the cost check"
json.dump(m, open("tmp/v52/S2/manifest.json", "w"), indent=1)
print(f"corrected {a}: shape / {c:.4f}")
PY
  fi
done
echo $arms > $R/PLAYED
mkdir -p $R/screen $R/confirm
for arm in base $arms; do
  play $R/configs/$arm.json $R/screen/rol-$arm.jsonl 400 93300000 $THREADS
done
{
  python3 engine-rs/scripts/v51b_report.py --roll-screen $R
  echo; python3 engine-rs/scripts/v51c_report.py --roles $(for a in base $arms; do echo $R/screen/rol-$a.jsonl; done)
} > $R/screen.md 2>&1
cat $R/screen.md
python3 engine-rs/scripts/v51b_report.py --roll-select $R > $R/selected.txt 2> $R/selection.log
cat $R/selection.log
sel=$(tr -d ' \n' < $R/selected.txt)
if [ -n "$sel" ]; then
  for arm in base $sel; do
    play $R/configs/$arm.json $R/confirm/rolc-$arm.jsonl 400 93400000 5 &
  done
  wait
  {
    python3 engine-rs/scripts/v51b_report.py --roll-confirm $R
    echo; python3 engine-rs/scripts/v51c_report.py --roles $R/confirm/rolc-base.jsonl $R/confirm/rolc-$sel.jsonl
  } > $R/confirm.md 2>&1
  cat $R/confirm.md
  win=$(sed -n 's/^NEW BASE: //p' $R/confirm.md)
  if [ -n "$win" ] && [ "$win" != "(none)" ]; then
    cp $R/configs/$win.json engine-rs/configs/v5.2-cand-ultra.json; echo "saved engine-rs/configs/v5.2-cand-ultra.json ($win)"
  fi
else
  echo "No Stage-2 arm cleared; no confirmation, as preregistered." | tee $R/confirm.md
fi
echo "R5S2 DONE $(date '+%F %T')"
