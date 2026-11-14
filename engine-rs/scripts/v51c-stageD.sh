#!/usr/bin/env bash
# Round 3, Stage D (preregistered 2026-11-14, "v5.1 round 3, Stage D" entry). Waits for the Stage-B driver
# (pid in tmp/v51c/B/chain.pid), applies the Stage-B reading rule (v51c_report.py --verdictB); only if
# VERDICT is REAL: clean cost of the four arms vs base (quiet machine), arms outside [0.97, 1.03] re-timed
# (check round, one correction), screen base + arms on 400 seeds 90,500,000, the best clearing arm
# confirmed with a fresh base arm on 400 seeds 90,600,000 (started together), accepted ->
# engine-rs/configs/v5.2-cand-ultra.json. Per-seat Pentobi processes if Stage B says PERSEAT: yes.
# Binary tmp/v51c/binD (engine 9e2df31). No block starts at or after 22:00. Sentinel "R3D DONE".
set -u
cd "$(dirname "$0")/../.."
D=tmp/v51c/D; BIN=tmp/v51c/binD; THREADS=10
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
before() { [ "$(date +%H%M)" -lt "$1" ]; }
bpid=$(cat tmp/v51c/B/chain.pid)
echo "R3D waiting for Stage B ($bpid) $(date '+%F %T')"
while kill -0 "$bpid" 2>/dev/null; do sleep 20; done
python3 engine-rs/scripts/v51c_report.py --verdictB tmp/v51c/B > $D/verdictB.txt 2>&1
cat $D/verdictB.txt
if ! grep -q "^VERDICT: REAL" $D/verdictB.txt; then
  echo "Stage B does not say REAL: Stage D not run, as preregistered."
  echo "R3D DONE $(date '+%F %T')"
  exit 0
fi
procs=shared; grep -q "^PERSEAT: yes" $D/verdictB.txt && procs=per-seat
echo "R3D start $(date '+%F %T'); Pentobi processes: $procs; $(sed -n 2p $BIN/PROVENANCE.txt)"
arms=$(cat $D/ARMS)
BIN=$BIN bash engine-rs/scripts/v51b-cost.sh $D screen $arms
python3 engine-rs/scripts/v51_report.py --cost $D screen | tee $D/cost/screen-cost.md
played=""; retimed=""
for a in $arms; do
  c=$(python3 -c "import json; print(json.load(open('$D/COSTS'))['$a'])")
  if python3 -c "import sys; sys.exit(0 if 0.97 <= float('$c') <= 1.03 else 1)"; then
    played="$played $a"
  else
    python3 engine-rs/scripts/v51b_configs.py retime $D $a "$c" > /dev/null
    played="$played $a-ET"; retimed="$retimed $a-ET"
  fi
done
if [ -n "$retimed" ]; then
  BIN=$BIN bash engine-rs/scripts/v51b-cost.sh $D check1 $retimed
  python3 engine-rs/scripts/v51_report.py --cost $D check1 | tee $D/cost/check1-cost.md
  for a in $retimed; do
    c=$(python3 -c "import json; print(json.load(open('$D/COSTS'))['$a'])")
    python3 -c "import sys; sys.exit(0 if 0.97 <= float('$c') <= 1.03 else 1)" || { python3 engine-rs/scripts/v51b_configs.py correct $D "${a%-ET}" "$c" > /dev/null; echo "corrected $a"; }
  done
fi
echo $played > $D/PLAYED
play() {  # play <arm> <out> <seeds> <base> <threads>
  before 2200 || { echo "=== $1 NOT STARTED (22:00)"; return; }
  echo "=== $(basename $2 .jsonl) start $(date '+%F %T')"
  "$BIN/blokee-pentobi" --blokee $D/configs/$1.json --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --gtp-processes $procs \
    --level 6 --budget 300 --threads $5 --seeds $3 --seed-base $4 --label "$(basename $2 .jsonl)" --out $2 --moves-out ${2%.jsonl}.moves.jsonl \
    2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror" || true
  echo "=== $(basename $2 .jsonl) done $(date '+%F %T')"
}
mkdir -p $D/screen $D/confirm
for arm in base $played; do
  play $arm $D/screen/rol-$arm.jsonl 400 90500000 $THREADS
done
python3 engine-rs/scripts/v51b_report.py --roll-screen $D > $D/screen.md 2>&1
python3 engine-rs/scripts/v51c_report.py --roles $(for a in base $played; do echo $D/screen/rol-$a.jsonl; done) >> $D/screen.md 2>&1
cat $D/screen.md
python3 engine-rs/scripts/v51b_report.py --roll-select $D > $D/selected.txt 2> $D/selection.log
cat $D/selection.log
sel=$(tr -d ' \n' < $D/selected.txt)
if [ -n "$sel" ]; then
  if before 2200; then
    for arm in base $sel; do
      play $arm $D/confirm/rolc-$arm.jsonl 400 90600000 5 &
    done
    wait
    python3 engine-rs/scripts/v51b_report.py --roll-confirm $D > $D/confirm.md 2>&1
    python3 engine-rs/scripts/v51c_report.py --roles $D/confirm/rolc-base.jsonl $D/confirm/rolc-$sel.jsonl >> $D/confirm.md 2>&1
  else
    echo "past 22:00: confirmation not started" > $D/confirm.md
  fi
  cat $D/confirm.md
  w=$(sed -n 's/^NEW BASE: //p' $D/confirm.md)
  if [ -n "$w" ] && [ "$w" != "(none)" ]; then
    cp $D/configs/$w.json engine-rs/configs/v5.2-cand-ultra.json; echo "saved engine-rs/configs/v5.2-cand-ultra.json ($w)"
  fi
else
  echo "No Stage D arm cleared; no confirmation, as preregistered." | tee $D/confirm.md
fi
echo "R3D DONE $(date '+%F %T')"
