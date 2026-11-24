#!/usr/bin/env bash
# Read the round-11 ultra screen at N seeds (N a multiple of 6): merges chunks 0..N/6-1 only (all must be
# complete for both arms) into $D/read-N/ and runs the standard read-out. Run only at the preregistered N.
# usage: bash engine-rs/scripts/v58-screen-read.sh <N>
#   L8 screen (amendment 3): D=/Users/paulkim/Blokee/tmp/v58/screen-l8 SB=104200000 bash engine-rs/scripts/v58-screen-read.sh 204
set -eu
cd "$(dirname "$0")/../.."
D=${D:-/Users/paulkim/Blokee/tmp/v58/screen}; SB=${SB:-104100000}; N=$1; K=$((N / 6)); R=$D/read-$N
[ $((K * 6)) -eq $N ] || { echo "N must be a multiple of 6"; exit 1; }
mkdir -p $R/screen $R/configs; cp $D/configs/*.json $R/configs/; cp $D/configs/U.json $R/configs/base.json
echo U32-8 > $R/PLAYED; cp $D/manifest.json $D/COSTS $R/
for arm in U U32-8; do
  for x in jsonl moves.jsonl timing.jsonl; do
    : > $R/screen/rol-$arm.$x
    for k in $(seq 0 $((K - 1))); do
      [ -f $D/chunks/scr-$arm-c$k.done ] || { echo "chunk $k of $arm not complete"; exit 1; }
      cat $D/chunks/scr-$arm-c$k.$x >> $R/screen/rol-$arm.$x
    done
  done
done
for x in jsonl moves.jsonl timing.jsonl; do cp $R/screen/rol-U.$x $R/screen/rol-base.$x; done
{ echo "Ultra screen, $N seeds from $SB"; python3 engine-rs/scripts/v51b_report.py --roll-screen $R; } | tee $R/screen.md
