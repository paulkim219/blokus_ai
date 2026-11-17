#!/usr/bin/env bash
# Round 9 amendment (prereg 2026-11-16 20:45 entry): after v56-after.sh ends ("R9A DONE"), the accepted nano
# candidate against level 4 (200 seeds, bench.sh layout: 101,600,000 + 40,000), because levels 1-3 do not bracket it.
set -u
cd "$(dirname "$0")/../.."
while ! grep -q "R9A DONE" tmp/v56/after.log; do sleep 30; done
[ "$(date +%Y%m%d%H%M)" -le 202611170715 ] || { echo "nano vs L4 NOT STARTED (07:15)"; exit; }
engine-rs/scripts/bench.sh engine-rs/configs/v5.3-cand-nano.json v5.3-cand-nano "4" 200 101600000 12 tmp/v56/bin
echo "R9B DONE $(date '+%F %T')"
