#!/usr/bin/env bash
# Stages 3 and 4 back to back, self-driving (preregistered 2026-11-13 "N11" and "S5" entries):
#   1. N11 chain (tmp/n11): prior re-fit arms vs the Stage-3 base; screen -> select -> cost -> confirm
#      -> level-7 benchmark of an accepted arm.
#   2. The final base: the accepted N11 arm if any, else the Stage-3 base. An accepted N11 config is
#      copied to engine-rs/configs/v5.0-n11-ultra.json.
#   3. S5 chain (tmp/s5): config-only arms built from the final base (tmp/s5/arms.json); an accepted S5
#      config is copied to engine-rs/configs/v5.0-s5-ultra.json.
#
#   nohup engine-rs/scripts/n11-s5-master.sh STAGE3_BASE.json > tmp/n11-s5-master.log 2>&1 &   # then caffeinate -w
# Sentinel lines: "MASTER N11 DONE", "MASTER DONE".
set -u
cd "$(dirname "$0")/../.."
BASE3=${1:?stage-3 base config}

echo "MASTER start $(date '+%F %T'); Stage-3 base $BASE3"
[ -f tmp/n11/configs/base.json ] || python3 engine-rs/scripts/chain_configs.py tmp/n11 "$BASE3" tmp/n11/arms.json
bash engine-rs/scripts/screen-chain.sh tmp/n11 > tmp/n11/chain.log 2>&1
tail -30 tmp/n11/chain.log
winner=$(sed -n 's/^NEW BASE: //p' tmp/n11/confirm.md 2>/dev/null)
final=$BASE3
if [ -n "$winner" ] && [ "$winner" != "(none)" ]; then
  cp "tmp/n11/configs/$winner.json" engine-rs/configs/v5.0-n11-ultra.json
  final=engine-rs/configs/v5.0-n11-ultra.json
fi
echo "MASTER N11 DONE $(date '+%F %T'); final base for S5: $final (N11 winner: ${winner:-none})"
echo "$final" > tmp/s5/FINAL_BASE
[ -f tmp/s5/configs/base.json ] || python3 engine-rs/scripts/chain_configs.py tmp/s5 "$final" tmp/s5/arms.json
bash engine-rs/scripts/screen-chain.sh tmp/s5 > tmp/s5/chain.log 2>&1
tail -30 tmp/s5/chain.log
winner5=$(sed -n 's/^NEW BASE: //p' tmp/s5/confirm.md 2>/dev/null)
if [ -n "$winner5" ] && [ "$winner5" != "(none)" ]; then
  cp "tmp/s5/configs/$winner5.json" engine-rs/configs/v5.0-s5-ultra.json
fi
echo "MASTER DONE $(date '+%F %T'); S5 winner: ${winner5:-none}"
