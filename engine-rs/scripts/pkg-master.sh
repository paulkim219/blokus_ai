#!/usr/bin/env bash
# Stage A (the Pentobi package) then Stage B (interiorInitVisits 1 replication), self-driving.
# Preregistered 2026-11-14 ("Package" and "IIV1 replication" entries in
# research_paper/v6_native_and_learning_preregistered.md); read-out engine-rs/scripts/pkg_report.py.
#
#   nohup engine-rs/scripts/pkg-master.sh > tmp/pkg/master.log 2>&1 &     # then caffeinate -i -s -m -w <pid>
#
# tmp/pkg must hold (committed with the prereg): ARMS, manifest.json, COSTS, configs/ (base, every arm,
# every -ET arm). Binary: tmp/pkg/bin (pinned). Match settings as S5: budget 300, Pentobi 31.0 level 6,
# Classic book, one Pentobi thread, 4 games per seed. Resumable (blokee-pentobi skips finished pairs).
# Sentinel lines: "PKG SCREEN DONE", "PKG CONFIRM DONE", "IIV SCREEN DONE", "MASTER DONE".
set -u
cd "$(dirname "$0")/../.."
ROOT=tmp/pkg
BROOT=tmp/iiv
BIN=${BIN:-tmp/pkg/bin}
THREADS=${THREADS:-10}
PENTOBI=${PENTOBI:-$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp}
BOOK=${BOOK:-$HOME/src/pentobi/opening_books/book_classic.blksgf}
load() { uptime | sed 's/.*load averages*: //'; }

play() {  # play <config> <label> <out.jsonl> <seeds> <seed-base> <threads> <level>
  "$BIN/blokee-pentobi" --blokee "$1" --pentobi "$PENTOBI" --book "$BOOK" \
    --mode one-blokee --level "$7" --budget 300 --threads "$6" \
    --seeds "$4" --seed-base "$5" --label "$2" --out "$3" --moves-out "${3%.jsonl}.moves.jsonl"
}

block() {  # block <config> <dir> <label> <seeds> <seed-base> <threads> <summary>
  local cfg=$1 dir=$2 label=$3
  mkdir -p "$dir"
  echo "=== $label start $(date '+%F %T') load: $(load)"
  play "$cfg" "$label" "$dir/$label.jsonl" "$4" "$5" "$6" 6 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|wall ms|wrote|rror" || true
  echo "=== $label done $(date '+%F %T') load: $(load)"
  {
    echo "=== $label ($(date '+%F %T'), load $(load))"
    [ -f "$dir/$label.failures.jsonl" ] && echo "HARD FAILURES: $(wc -l < "$dir/$label.failures.jsonl")"
    npx tsx scripts/aggregateMatches.ts "$dir/$label.jsonl"
    echo
  } >> "$7" 2>&1
}

echo "MASTER start $(date '+%F %T'); binary $BIN"
# ---------------- Stage A screen: 400 seeds from 88,000,000, one arm at a time.
for arm in base $(cat $ROOT/ARMS); do
  block "$ROOT/configs/$arm.json" "$ROOT/screen" "pkgs-$arm" 400 88000000 "$THREADS" "$ROOT/summary.txt"
done
echo "PKG SCREEN DONE $(date '+%F %T')"
python3 engine-rs/scripts/pkg_report.py --screen $ROOT > $ROOT/screen.md
cat $ROOT/screen.md
python3 engine-rs/scripts/pkg_report.py --select $ROOT > $ROOT/selected.txt 2> $ROOT/selection.log
cat $ROOT/selection.log
newbase=engine-rs/configs/v5.0-s4-ultra.json
if [ -s $ROOT/selected.txt ]; then
  carms="base"
  for a in $(cat $ROOT/selected.txt); do
    carms="$carms $a"
    over=$(python3 -c "import json; c=json.load(open('$ROOT/COSTS')); print(1 if c.get('$a', 0) > 1.25 and not '$a'.endswith('-ET') else 0)")
    if [ "$over" = 1 ]; then carms="$carms $a-ET"; fi
  done
  carms=$(echo $carms | tr ' ' '\n' | awk '!seen[$0]++' | tr '\n' ' ')
  echo "$carms" > $ROOT/CONFIRM_ARMS
  n=$(echo $carms | wc -w | tr -d ' ')
  per=$(( THREADS / n )); [ "$per" -ge 1 ] || per=1
  echo "PKG confirmation start $(date '+%F %T'): $carms; 400 seeds from 88,100,000; $per threads each"
  for arm in $carms; do
    block "$ROOT/configs/$arm.json" "$ROOT/confirm" "pkgc-$arm" 400 88100000 "$per" "$ROOT/summary.txt" &
  done
  wait
  python3 engine-rs/scripts/pkg_report.py --confirm $ROOT > $ROOT/confirm.md
  cat $ROOT/confirm.md
  winner=$(sed -n 's/^NEW BASE: //p' $ROOT/confirm.md)
  if [ -n "$winner" ] && [ "$winner" != "(none)" ]; then
    name=$(echo "$winner" | tr 'A-Z' 'a-z')
    cp "$ROOT/configs/$winner.json" "engine-rs/configs/v5.0-$name-ultra.json"
    newbase="engine-rs/configs/v5.0-$name-ultra.json"
  fi
else
  echo "No arm cleared the screen; no confirmation, as preregistered." | tee $ROOT/confirm.md
  echo "NEW BASE: (none)" >> $ROOT/confirm.md
fi
echo "PKG CONFIRM DONE $(date '+%F %T'); base for Stage B: $newbase"
echo "$newbase" > $ROOT/FINAL_BASE
# ---------------- Stage B: IIV1 vs the then-current base, 400 + 400 fresh seeds.
mkdir -p $BROOT/configs
python3 - "$newbase" $BROOT <<'EOF'
import json, sys
base, root = sys.argv[1], sys.argv[2]
c = json.load(open(base))
json.dump(c, open(f"{root}/configs/base.json", "w"), indent=1)
assert c["native"]["candidates"]["interiorInitVisits"] == 3.0, "interiorInitVisits no longer 3 in the base"
c["native"]["candidates"]["interiorInitVisits"] = 1.0
json.dump(c, open(f"{root}/configs/IIV1.json", "w"), indent=1)
json.dump({"base": f"{base} unchanged", "IIV1": "native.candidates.interiorInitVisits 3 -> 1"}, open(f"{root}/manifest.json", "w"), indent=1)
EOF
for blk in b1:88200000 b2:88300000; do
  b=${blk%%:*}; s=${blk##*:}
  for arm in base IIV1; do
    block "$BROOT/configs/$arm.json" "$BROOT/$b" "iiv$b-$arm" 400 "$s" "$THREADS" "$BROOT/summary.txt"
  done
done
echo "IIV SCREEN DONE $(date '+%F %T')"
python3 engine-rs/scripts/pkg_report.py --rep $BROOT > $BROOT/rep.md
cat $BROOT/rep.md
if grep -q "^NEW BASE: IIV1" $BROOT/rep.md; then
  cp $BROOT/configs/IIV1.json engine-rs/configs/v5.0-iiv1-ultra.json
  echo "IIV1 accepted: engine-rs/configs/v5.0-iiv1-ultra.json"
fi
echo "MASTER DONE $(date '+%F %T')"
