# v7 confirmation (research_paper/v7_seat_strategy_preregistered.md): 1,600 seeds from 75,000,000.
source ~/.cargo/env; export PATH=$HOME/.local/bin:$PATH
cd ~/Blokee; D=ml/data/seat; B=engine-rs/configs/v4.2-ultra.json; N=1600; S=75000000
run() {  # run <label> <challenger> <out>
  [ -s "$3" ] && [ "$(wc -l < "$3")" -eq $((N * 4)) ] && { echo "skip $1 (complete)"; return; }
  rm -f "$3"
  engine-rs/target/release/blokee-match --challenger "$2" --champion $B --seeds $N --seed-base $S \
    --budget 300 --threads 15 --label "$1" --out "$3" 2>&1 | tr '\r' '\n' | tail -1
  echo "[$(date +%T)] done $1"
}
run v7-mirror  $B                     $D/v7-mirror.jsonl
run v7-agg140  $D/configs/agg140.json $D/v7-agg140.jsonl
run v7-flat    $D/configs/flat.json   $D/v7-flat.jsonl
for v in agg140 flat; do
  ml/.venv-torch/bin/python ml/seat/seat_report.py $D/v7-$v.jsonl $D/v7-mirror.jsonl | tee ml/seat/results/v7-$v.txt
done
