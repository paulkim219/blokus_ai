#!/usr/bin/env bash
# The standard benchmark (docs/BENCHMARK.md): one lone Blokee seat against three Pentobi 31.0 seats of each
# anchor level, per-seat Pentobi processes with seat-derived seeds, opening book on, budget 300, four seat
# rotations per seed. Writes tmp/bench/<name>/vs-L<k>.jsonl (+ .moves.jsonl, .timing.jsonl); read with
#   python3 engine-rs/scripts/v53_report.py --bench tmp/v53 --engine <name> tmp/bench/<name>
#
# usage: engine-rs/scripts/bench.sh <config.json> <name> "<levels>" <seeds> <seed-base> [threads] [binary dir]
#   e.g. engine-rs/scripts/bench.sh engine-rs/configs/v5.2.json v5.2 "4 5 6" 200 100900000 10 tmp/v55/bin
# Each level uses its own seed block: seed-base + 10,000 * level (so levels never share seeds).
# Run it under caffeinate (the Mac's maintenance sleep stalls matches):
#   caffeinate -i -s -m engine-rs/scripts/bench.sh ...
set -u
cd "$(dirname "$0")/../.."
cfg=$1; name=$2; levels=$3; n=$4; sb=$5; th=${6:-10}; BIN=${7:-engine-rs/target/release}
PENTOBI=$HOME/src/pentobi-build/pentobi_gtp/pentobi-gtp; BOOK=$HOME/src/pentobi/opening_books/book_classic.blksgf
out=tmp/bench/$name; mkdir -p "$out"; cp "$cfg" "$out/config.json"
for k in $levels; do
  s=$((sb + 10000 * k))
  echo "=== $name vs L$k: $n seeds from $s, start $(date '+%F %T')"
  "$BIN/blokee-pentobi" --blokee "$cfg" --pentobi "$PENTOBI" --book "$BOOK" --mode one-blokee --gtp-processes per-seat \
    --level "$k" --budget 300 --threads "$th" --seeds "$n" --seed-base "$s" --label "$name-vs-L$k" \
    --out "$out/vs-L$k.jsonl" --moves-out "$out/vs-L$k.moves.jsonl" 2>&1 | tr '\r' '\n' | grep -E "unsupported|panic|HARD|rror" || true
  echo "=== $name vs L$k done $(date '+%F %T')"
done
python3 engine-rs/scripts/v53_report.py --bench tmp/v53 --engine "$name" "$out" > "$out/bench.md" 2>&1
cat "$out/bench.md"
