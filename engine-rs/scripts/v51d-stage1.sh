#!/usr/bin/env bash
# Round 4, Stage 1 core (preregistered 2026-11-14 19:55, "round 4, Stage 1" entry): the fair benchmark,
# one pentobi-gtp process per Pentobi seat (seeded per seat). Order:
#   Pentobi search statistics on the clean-timing seeds (5 seeds 91,950,000, logged, 4 threads)
#   v5.0-ultra, v5.1-ultra lone vs three L6: 400 seeds 91,000,000, then 400 seeds 91,100,000
#   v4.2-ultra lone vs three L6: 200 seeds 91,200,000
#   one L6 vs three v5.1-ultra: 200 seeds 91,400,000
#   two-two v5.1-ultra with L6: 200 seeds 91,500,000
# (v5.1 vs three level-7 seats, 91,300,000, runs later in the Stage-2 driver.) Binary tmp/v51d/bin.
# No block starts at or after 00:30. Sentinel "R4S1 DONE".
set -u
cd "$(dirname "$0")/../.."
R=tmp/v51d/S1; BIN=tmp/v51d/bin; THREADS=10
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
ok() { h=$(date +%H%M); [ "$h" -lt 0030 ] || [ "$h" -ge 1200 ]; }
play() {  # play <config> <out> <seeds> <base> <mode> <level> [extra]
  ok || { echo "=== $(basename $2) NOT STARTED (00:30)"; return; }
  echo "=== $(basename $2 .jsonl) start $(date '+%F %T')"
  "$BIN/blokee-pentobi" --blokee "$1" --pentobi "$PENTOBI" --book "$BOOK" --mode "$5" --gtp-processes per-seat \
    --level "$6" --budget 300 --threads $THREADS --seeds "$3" --seed-base "$4" --label "$(basename $2 .jsonl)" \
    --out "$2" --moves-out "${2%.jsonl}.moves.jsonl" ${7:-} 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror" || true
  echo "=== $(basename $2 .jsonl) done $(date '+%F %T')"
}
echo "R4S1 start $(date '+%F %T'); $(sed -n 2p $BIN/PROVENANCE.txt)"
mkdir -p $R/c1 $R/c2 $R/stats
"$BIN/blokee-pentobi" --blokee engine-rs/configs/v5.1-ultra.json --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --gtp-processes per-seat \
  --pentobi-log $R/stats/logs --level 6 --budget 300 --threads 4 --seeds 5 --seed-base 91950000 --label stats \
  --out $R/stats/stats.jsonl --moves-out $R/stats/stats.moves.jsonl 2>&1 | grep -E "wall|HARD" || true
for blk in c1:91000000 c2:91100000; do
  b=${blk%%:*}; s=${blk##*:}
  for c in v5.0-ultra v5.1-ultra; do
    play engine-rs/configs/$c.json $R/$b/lone-$c.jsonl 400 $s one-blokee 6
  done
done
play engine-rs/configs/v4.2-ultra.json $R/v42-l6.jsonl 200 91200000 one-blokee 6
play engine-rs/configs/v5.1-ultra.json $R/rev-l6.jsonl 200 91400000 one-pentobi 6
play engine-rs/configs/v5.1-ultra.json $R/par-v51.jsonl 200 91500000 two-two 6
python3 engine-rs/scripts/v51d_report.py --stage1 $R > $R/stage1.md 2>&1
python3 engine-rs/scripts/v51b_report.py --parity $R/par-v51.jsonl > $R/parity.md 2>&1
cat $R/stage1.md $R/parity.md
echo "R4S1 DONE $(date '+%F %T')"
