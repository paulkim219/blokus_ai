#!/usr/bin/env bash
# Round 11 Step C: idle memory baseline and Pentobi per-process RSS at levels 8 and 9 (one unscored
# ladder game each, lone level 1, seed 104,900,000, one rotation; level 9 stopped after 8 minutes).
set -u
T=/Users/paulkim/Blokee/tmp; V=$T/v58; M=$V/mem; B=$T/hb/bin2; LOG=$V/cpu-log.txt
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
mkdir -p $M; cd /Users/paulkim/Blokee-hb
snap() { vm_stat | awk -v t="$1" '/Pages free/{f=$3}/Anonymous/{a=$3}/occupied by compressor/{c=$3}/wired down/{w=$4}/File-backed/{fb=$3}
  END{printf "%s free %.2f GB; wired %.2f; anonymous %.2f; compressor-occupied %.2f; file-backed %.2f; B = wired+anon+compressor = %.2f GB\n", t, f*16384/1e9, w*16384/1e9, a*16384/1e9, c*16384/1e9, fb*16384/1e9, (w+a+c)*16384/1e9}'; }
snap "$(date '+%F %T') baseline (no game running)" >> $M/baseline.txt; sysctl vm.swapusage >> $M/baseline.txt
for L in 8 9; do
  s=$(date '+%T'); lim=$([ $L = 9 ] && echo 480 || echo 900)
  bash -c "exec $B/blokee-pentobi --blokee $V/configs/U.json --pentobi $PENTOBI --book $BOOK --mode pentobi-ladder --lone-level 1 --level $L \
    --gtp-processes per-seat --budget 300 --threads 1 --seeds 1 --seed-base 104900000 --rotations 1 --label mem-L$L --out $M/mem-L$L.jsonl" > $M/mem-L$L.log 2>&1 &
  pid=$!; t0=$(date +%s)
  while kill -0 $pid 2>/dev/null; do
    ps -Ao rss=,args= | awk -v T="$(date '+%T')" '$2 ~ /pentobi-gtp$/ && /--level/ {lv=""; for(i=1;i<=NF;i++) if($i=="--level") lv=$(i+1); print T, "level", lv, "rss_kb", $1}' >> $M/rss-L$L.txt
    [ $(( $(date +%s) - t0 )) -ge $lim ] && { kill $pid; pkill -P $pid 2>/dev/null; echo "stopped at ${lim}s" >> $M/mem-L$L.log; }
    sleep 5
  done
  echo "$(date '+%F') $s-$(date '+%T') v58 mem: ladder L1 vs 3 x L$L, 1 game, seed 104900000 (unscored) [~1 core]" >> $LOG
  awk -v L=$L '$3==L{if($5>m)m=$5}END{printf "level %s: max per-process RSS %.2f GB\n", L, m/1e6}' $M/rss-L$L.txt >> $M/pentobi.txt
done
snap "$(date '+%F %T') after" >> $M/baseline.txt
