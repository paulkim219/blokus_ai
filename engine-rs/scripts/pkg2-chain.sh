#!/usr/bin/env bash
# Amendment 2026-11-14 04:10 (research_paper/v6_native_and_learning_preregistered.md): after the
# 88,100,000 package confirmation (started by pkg-master.sh, whose master was stopped by hand so that
# Stage B does not run), read it out; confirm PKG-noROLL on 88,800,000; apply the final-base rule; then
# Stage C and D (s6d-post.sh) on that base.
#
#   nohup engine-rs/scripts/pkg2-chain.sh "<pids of the running confirmation blocks>" > tmp/pkg/chain2.log 2>&1 &
#   (then caffeinate -i -s -m -w <pid>)
# Sentinels: "PKG CONFIRM DONE", "PKGR CONFIRM DONE", "FINAL BASE <path>", then s6d-post.sh's.
set -u
cd "$(dirname "$0")/../.."
ROOT=tmp/pkg
BIN=tmp/pkg/bin
PENTOBI=${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}
BOOK=${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}
load() { uptime | sed 's/.*load averages*: //'; }
late() { [ "$(date +%H%M)" -ge 0815 ] && [ "$(date +%H)" -lt 12 ]; }

echo "CHAIN2 start $(date '+%F %T'); waiting for confirmation blocks: $1"
for p in $1; do while kill -0 "$p" 2>/dev/null; do sleep 20; done; done
python3 engine-rs/scripts/pkg_report.py --confirm $ROOT > $ROOT/confirm.md
cat $ROOT/confirm.md
winner=$(sed -n 's/^NEW BASE: //p' $ROOT/confirm.md)
first=""
if [ -n "$winner" ] && [ "$winner" != "(none)" ]; then
  name=$(echo "$winner" | tr 'A-Z' 'a-z')
  cp "$ROOT/configs/$winner.json" "engine-rs/configs/v5.0-$name-ultra.json"
  first="engine-rs/configs/v5.0-$name-ultra.json"
  echo "88,100,000 confirmation saved $first"
fi
echo "PKG CONFIRM DONE $(date '+%F %T'); saved: ${first:-none}"

# PKG-noROLL confirmation, 400 seeds from 88,800,000, three arms together.
if late; then
  echo "past the cut-off: PKG-noROLL confirmation not started"
else
  mkdir -p $ROOT/confirm2
  echo "PKGR confirmation start $(date '+%F %T') load: $(load)"
  for arm in base PKG-noROLL PKG-noROLL-ET; do
    (
      "$BIN/blokee-pentobi" --blokee $ROOT/configs/$arm.json --pentobi "$PENTOBI" --book "$BOOK" \
        --mode one-blokee --level 6 --budget 300 --threads 3 --seeds 400 --seed-base 88800000 \
        --label pkgr-$arm --out $ROOT/confirm2/pkgr-$arm.jsonl --moves-out $ROOT/confirm2/pkgr-$arm.moves.jsonl \
        2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|rror"
      echo "=== pkgr-$arm done $(date '+%F %T')"
      { echo "=== pkgr-$arm ($(date '+%F %T'))"; npx tsx scripts/aggregateMatches.ts $ROOT/confirm2/pkgr-$arm.jsonl; echo; } >> $ROOT/summary.txt 2>&1
    ) &
  done
  wait
  python3 engine-rs/scripts/pkg_report.py --confirm2 $ROOT > $ROOT/confirm2.md
  cat $ROOT/confirm2.md
fi
echo "PKGR CONFIRM DONE $(date '+%F %T')"

final=engine-rs/configs/v5.0-s4-ultra.json
if grep -q "^NEW BASE: PKG-noROLL-ET" $ROOT/confirm2.md 2>/dev/null; then
  cp $ROOT/configs/PKG-noROLL-ET.json engine-rs/configs/v5.0-pk-ultra.json
  final=engine-rs/configs/v5.0-pk-ultra.json
elif [ "$winner" = "PKG-ET" ] || [ "$winner" = "PKG-noLGR-ET" ]; then
  final=$first
fi
echo "$final" > $ROOT/FINAL_BASE
echo "FINAL BASE $final ($(date '+%F %T'))"
bash engine-rs/scripts/s6d-post.sh >> tmp/s6/post.log 2>&1
tail -40 tmp/s6/post.log
echo "CHAIN2 DONE $(date '+%F %T')"
