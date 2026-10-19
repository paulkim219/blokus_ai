# Positional baseline: v4.2-ultra mirror on the powered-confirmation seeds (74,200,000–74,200,799).
source ~/.cargo/env; export PATH=$HOME/.local/bin:$PATH
cd ~/Blokee; mkdir -p ml/data/seat; C=engine-rs/configs/v4.2-ultra.json
engine-rs/target/release/blokee-match --challenger $C --champion $C --seeds 800 --seed-base 74200000 \
  --budget 300 --threads 15 --label mirror-v42u --out ml/data/seat/mirror-74200000.jsonl 2>&1 | tr '\r' '\n' | tail -1
npx tsx scripts/aggregateMatches.ts ml/data/seat/mirror-74200000.jsonl | tee ml/data/seat/mirror-74200000.txt
