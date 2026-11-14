#!/usr/bin/env bash
# Second v5.1 round, self-driving (preregistered 2026-11-14 13:30, "v5.1 round 2" entry in
# research_paper/v6_native_and_learning_preregistered.md; read-out engine-rs/scripts/v51b_report.py):
#   Stage 1  replication: base, IIV1-ET, X04, COMBO-ET on 400 seeds 89,500,000 then 400 seeds 89,600,000
#            (10 threads, one arm at a time); pooled 800-seed rule; an accepted arm -> engine-rs/configs/v5.1-ultra.json
#   Stage 2  parity: two v5.0-ultra seats vs two level-6 seats, six seat pairs per seed, 200 seeds 89,700,000
#   Stage 3  rollout cost at equal time on the base after Stage 1: clean cost (quiet), re-time every arm,
#            check round (one correction if outside [0.97, 1.03]); screen base + 5 arms, 400 seeds 89,800,000;
#            best clearing arm confirmed with a fresh base arm on 400 seeds 89,900,000 (started together)
#   Extra    only if v5.1-ultra.json was saved by this chain: v5.1 vs three v5.0-ultra (blokee-match, 200 seeds
#            89,400,000; started before 17:30), then v5.1 vs three level-7 seats (200 seeds 89,300,000; before 17:05)
# No match block starts at or after 17:30 CST.
#
#   nohup engine-rs/scripts/v51b-chain.sh > tmp/v51b/chain.log 2>&1 &     # then caffeinate -i -s -m -w <pid>
# Sentinels: "R2 STAGE1 DONE", "R2 STAGE2 DONE", "R2 STAGE3 DONE", "R2 CHAIN DONE".
set -u
cd "$(dirname "$0")/../.."
R=tmp/v51b
BIN=$R/bin
THREADS=${THREADS:-10}
PENTOBI=${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}
BOOK=${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}
SUMMARY=$R/summary.txt
load() { uptime | sed 's/.*load averages*: //'; }
before() { [ "$(date +%H%M)" -lt "$1" ]; }

play() {  # play <config> <label> <out.jsonl> <seeds> <seed-base> <threads> <level> <mode>
  "$BIN/blokee-pentobi" --blokee "$1" --pentobi "$PENTOBI" --book "$BOOK" \
    --mode "$8" --level "$7" --budget 300 --threads "$6" \
    --seeds "$4" --seed-base "$5" --label "$2" --out "$3" --moves-out "${3%.jsonl}.moves.jsonl"
}

block() {  # block <config> <out.jsonl> <label> <seeds> <seed-base> <threads> <level> [mode]
  local cfg=$1 out=$2 label=$3 mode=${8:-one-blokee}
  if ! before 1730; then echo "=== $label NOT STARTED (17:30 cut-off) $(date '+%F %T')"; return; fi
  mkdir -p "$(dirname "$out")"
  echo "=== $label start $(date '+%F %T') load: $(load)"
  play "$cfg" "$label" "$out" "$4" "$5" "$6" "$7" "$mode" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|wrote|rror" || true
  echo "=== $label done $(date '+%F %T') load: $(load)"
  if [ "$mode" = one-blokee ]; then
    {
      echo "=== $label ($(date '+%F %T'), load $(load))"
      [ -f "${out%.jsonl}.failures.jsonl" ] && echo "HARD FAILURES: $(wc -l < "${out%.jsonl}.failures.jsonl")"
      npx tsx scripts/aggregateMatches.ts "$out"
      echo
    } >> "$SUMMARY" 2>&1
  fi
}

echo "R2 chain start $(date '+%F %T'); binary $BIN ($(sed -n 2p $BIN/PROVENANCE.txt))"
# ---------------- Stage 1
S1=$R/rep
for blk in b1:89500000 b2:89600000; do
  b=${blk%%:*}; s=${blk##*:}
  for arm in base $(cat $S1/PLAYED); do
    block "$S1/configs/$arm.json" "$S1/$b/rep-$arm.jsonl" "rep-$arm" 400 "$s" "$THREADS" 6
  done
done
python3 engine-rs/scripts/v51b_report.py --rep $S1 > $S1/rep.md 2>&1
cat $S1/rep.md
cur=engine-rs/configs/v5.0-ultra.json
v51=""
w1=$(sed -n 's/^NEW BASE: //p' $S1/rep.md)
if [ -n "$w1" ] && [ "$w1" != "(none)" ]; then
  cp "$S1/configs/$w1.json" engine-rs/configs/v5.1-ultra.json
  cur=engine-rs/configs/v5.1-ultra.json; v51=$cur
fi
echo "R2 STAGE1 DONE $(date '+%F %T'); v5.1: ${v51:-none} (${w1:-none}); Stage 3 base $cur"

# ---------------- Stage 2
P=$R/par
block engine-rs/configs/v5.0-ultra.json "$P/par-v5.0-ultra.jsonl" par-v5.0-ultra 200 89700000 "$THREADS" 6 two-two
[ -f "$P/par-v5.0-ultra.jsonl" ] && python3 engine-rs/scripts/v51b_report.py --parity "$P/par-v5.0-ultra.jsonl" > $P/parity.md 2>&1
cat $P/parity.md 2>/dev/null
echo "R2 STAGE2 DONE $(date '+%F %T')"

# ---------------- Stage 3
S3=$R/roll
python3 engine-rs/scripts/v51b_configs.py stage3 $S3 "$cur"
arms=$(cat $S3/ARMS)
BIN=$BIN bash engine-rs/scripts/v51b-cost.sh $S3 screen $arms
python3 engine-rs/scripts/v51_report.py --cost $S3 screen | tee $S3/cost/screen-cost.md
played=""; check=""
for a in $arms; do
  c=$(python3 -c "import json; print(json.load(open('$S3/COSTS'))['$a'])")
  python3 engine-rs/scripts/v51b_configs.py retime $S3 $a "$c" > /dev/null
  played="$played $a-ET"
done
BIN=$BIN bash engine-rs/scripts/v51b-cost.sh $S3 check1 $played
python3 engine-rs/scripts/v51_report.py --cost $S3 check1 | tee $S3/cost/check1-cost.md
corrected=""
for a in $played; do
  c=$(python3 -c "import json; print(json.load(open('$S3/COSTS'))['$a'])")
  if python3 -c "import sys; sys.exit(0 if 0.97 <= float('$c') <= 1.03 else 1)"; then :; else
    python3 engine-rs/scripts/v51b_configs.py correct $S3 "${a%-ET}" "$c" > /dev/null
    corrected="$corrected $a"
  fi
done
if [ -n "$corrected" ]; then
  echo "corrected once:$corrected"
  BIN=$BIN bash engine-rs/scripts/v51b-cost.sh $S3 check2 $corrected
  python3 engine-rs/scripts/v51_report.py --cost $S3 check2 | tee $S3/cost/check2-cost.md
fi
echo $played > $S3/PLAYED
for arm in base $played; do
  block "$S3/configs/$arm.json" "$S3/screen/rol-$arm.jsonl" "rol-$arm" 400 89800000 "$THREADS" 6
done
python3 engine-rs/scripts/v51b_report.py --roll-screen $S3 > $S3/screen.md 2>&1
cat $S3/screen.md
python3 engine-rs/scripts/v51b_report.py --roll-select $S3 > $S3/selected.txt 2> $S3/selection.log
cat $S3/selection.log
sel=$(cat $S3/selected.txt | tr -d ' \n')
if [ -n "$sel" ]; then
  if before 1730; then
    echo "R2 Stage 3 confirmation start $(date '+%F %T'): base $sel; 400 seeds from 89,900,000; 5 threads each"
    for arm in base $sel; do
      block "$S3/configs/$arm.json" "$S3/confirm/rolc-$arm.jsonl" "rolc-$arm" 400 89900000 5 6 &
    done
    wait
    python3 engine-rs/scripts/v51b_report.py --roll-confirm $S3 > $S3/confirm.md 2>&1
  else
    echo "past 17:30: Stage 3 confirmation not started" | tee $S3/confirm.md
  fi
  cat $S3/confirm.md
  w3=$(sed -n 's/^NEW BASE: //p' $S3/confirm.md)
  if [ -n "$w3" ] && [ "$w3" != "(none)" ]; then
    if [ -n "$v51" ]; then
      cp "$S3/configs/$w3.json" engine-rs/configs/v5.2-cand-ultra.json; echo "saved engine-rs/configs/v5.2-cand-ultra.json ($w3)"
    else
      cp "$S3/configs/$w3.json" engine-rs/configs/v5.1-ultra.json; v51=engine-rs/configs/v5.1-ultra.json; echo "saved engine-rs/configs/v5.1-ultra.json ($w3)"
    fi
  fi
else
  echo "No Stage 3 arm cleared; no confirmation, as preregistered." | tee $S3/confirm.md
fi
echo "R2 STAGE3 DONE $(date '+%F %T')"

# ---------------- Extra blocks on a v5.1 saved by this chain
if [ -n "$v51" ]; then
  X=$R/extra; mkdir -p $X
  if before 1730; then
    echo "=== v51-h2h start $(date '+%F %T') load: $(load)"
    "$BIN/blokee-match" --challenger "$v51" --champion engine-rs/configs/v5.0-ultra.json --challenger-name v5.1-ultra \
      --champion-name v5.0-ultra --seeds 200 --seed-base 89400000 --budget 300 --threads "$THREADS" \
      --label v51-h2h --out $X/v51-h2h.jsonl 2>&1 | tail -1
    echo "=== v51-h2h done $(date '+%F %T') load: $(load)"
  else
    echo "past 17:30: head-to-head not started"
  fi
  if before 1705; then
    block "$v51" $X/v51-l7.jsonl v51-l7 200 89300000 "$THREADS" 7
  else
    echo "past 17:05: level-7 block not started (would not finish by 18:00)"
  fi
  python3 engine-rs/scripts/v51b_report.py --extra $X 2>&1 | tee $X/extra.md
fi
echo "R2 CHAIN DONE $(date '+%F %T')"
