# Exploratory seat-strategy screen: each variant vs v4.2-ultra, 400 seeds from 74,200,000 (paired with the mirror).
source ~/.cargo/env; export PATH=$HOME/.local/bin:$PATH
cd ~/Blokee; D=ml/data/seat; SP=ml/seat
ml/.venv-torch/bin/python $SP/mkvariants.py
while pgrep -f "label mirror-v42u" >/dev/null; do sleep 20; done
for v in ${VARIANTS:-rb0 rb70 rb100 flat agg140 agg60}; do
  engine-rs/target/release/blokee-match --challenger $D/configs/$v.json --champion engine-rs/configs/v4.2-ultra.json \
    --seeds 400 --seed-base 74200000 --budget 300 --threads 15 --label seat-$v --out $D/$v.jsonl 2>&1 | tr '\r' '\n' | tail -1
  ml/.venv-torch/bin/python $SP/seat_report.py $D/$v.jsonl $D/mirror-74200000.jsonl | tee $D/$v.txt
done
