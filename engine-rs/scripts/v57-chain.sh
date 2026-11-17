#!/usr/bin/env bash
# Round 10 driver (preregistered 2026-11-17, "Round 10" in research_paper/v5_1_candidates_results.md):
# pro confirmation of the interior cap W1D-ET (floor(16 + 4*sqrt N), iterationScale 239.172) against v5.2-pro
# (224.487), each as the lone seat vs three Pentobi level-7 seats, 800 fresh seeds 102,000,000-102,000,799.
# Binary tmp/v57/bin (byte copy of tmp/v56/bin = round 8's tmp/v55/bin-w1, engine f2c01ee; PROVENANCE.txt).
# ROOT tmp/v57/pro: configs/ (byte copies of round 9's), chunks/rol-<arm>-c<k>.* (100-seed chunks, both arms
# per chunk, order alternating: even chunks base first, odd chunks W1D-ET first), confirm/rolc-<arm>.* (merged).
# Resumable: a chunk-arm with a .done marker and 400 result lines is skipped; anything else is deleted and replayed.
# Sentinels "R10 CHUNK <k> DONE", "R10 CONFIRM DONE", "R10 BENCH DONE", "R10 DONE".
# usage: caffeinate -i -s -m engine-rs/scripts/v57-chain.sh   (or start it, then caffeinate -w <pid>)
set -u
cd "$(dirname "$0")/../.."
BIN=tmp/v57/bin; D=tmp/v57/pro; TH=12
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
mkdir -p $D/chunks $D/confirm
play() {  # play <arm> <chunk>
  local arm=$1 k=$2 sb=$((102000000 + 100 * $2)); local out=$D/chunks/rol-$arm-c$k
  if [ -f $out.done ] && [ "$(wc -l < $out.jsonl)" -eq 400 ]; then echo "=== rol-$arm-c$k complete, skipped"; return 0; fi
  rm -f $out.jsonl $out.moves.jsonl $out.timing.jsonl $out.done
  echo "=== rol-$arm-c$k start $(date '+%F %T') (100 seeds from $sb, level 7)"
  "$BIN/blokee-pentobi" --blokee $D/configs/$arm.json --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --gtp-processes per-seat \
    --level 7 --budget 300 --threads "$TH" --seeds 100 --seed-base "$sb" --label "rol-$arm-c$k" \
    --out $out.jsonl --moves-out $out.moves.jsonl 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|rror" || true
  if [ "$(wc -l < $out.jsonl 2>/dev/null || echo 0)" -eq 400 ]; then touch $out.done; echo "=== rol-$arm-c$k done $(date '+%F %T')"
  else echo "=== rol-$arm-c$k INCOMPLETE $(date '+%F %T')"; return 1; fi
}
merge() {  # explicit chunk files per extension (round 9's glob bug: never let *.jsonl catch .moves/.timing)
  for arm in base W1D-ET; do
    for x in jsonl moves.jsonl timing.jsonl; do
      : > $D/confirm/rolc-$arm.$x
      for k in 0 1 2 3 4 5 6 7; do [ -f $D/chunks/rol-$arm-c$k.done ] && cat $D/chunks/rol-$arm-c$k.$x >> $D/confirm/rolc-$arm.$x; done
    done
  done
}
echo "R10 start $(date '+%F %T')"
for k in 0 1 2 3 4 5 6 7; do
  if [ $((k % 2)) -eq 0 ]; then order="base W1D-ET"; else order="W1D-ET base"; fi
  for arm in $order; do play $arm $k || exit 1; done
  echo "R10 CHUNK $k DONE $(date '+%F %T')"
done
merge
python3 engine-rs/scripts/v51b_report.py --roll-confirm $D 800 > $D/confirm.md 2>&1
python3 engine-rs/scripts/v57_pro_report.py > $D/report.md 2>&1
echo "R10 CONFIRM DONE $(date '+%F %T'): $(grep '^NEW BASE' $D/confirm.md)"
# Benchmark fill-in, only if W1D-ET is accepted: L7 anchor = the 800-seed confirmation block (linked in);
# L6, 200 seeds 102,160,000 (bench.sh seed base 102,100,000). L8 only by a committed amendment.
if [ "$(sed -n 's/^NEW BASE: //p' $D/confirm.md)" = "W1D-ET" ]; then
  G=engine-rs/configs; name=v5.3-cand-pro; B=tmp/bench/$name
  cp $D/configs/W1D-ET.json $G/$name.json; cmp $D/configs/W1D-ET.json $G/$name.json && echo "W1D-ET saved as $G/$name.json"
  mkdir -p $B
  for x in jsonl moves.jsonl timing.jsonl; do ln -sf ../../../$D/confirm/rolc-W1D-ET.$x $B/vs-L7.$x; done
  engine-rs/scripts/bench.sh $G/$name.json $name 6 200 102100000 $TH $BIN
  echo "R10 BENCH DONE $(date '+%F %T')"
else
  echo "R10 BENCH not run (nothing accepted)"
fi
echo "R10 DONE $(date '+%F %T')"
