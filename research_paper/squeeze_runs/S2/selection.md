## S2: adversary budget for SQP (/home/paulk/Blokee/research_paper/squeeze_runs/S2); mean target squares placed of 89

| Target | `SQP-l6` | `SQP-l6x4` | `SQP-pro` |
|---|---:|---:|---:|
| v5.2-nano | 46.7 | 41.5 | 39.9 |
| v5.2-lite | 46.3 | 41.5 | 40.5 |
| v5.2 | 48.4 | 43.5 | 42.1 |
| v5.2-pro | 51.1 | 45.5 | 44.3 |
| Pentobi level 1 | 44.2 | 41.4 | 40.6 |
| Pentobi level 3 | 46.5 | 43.1 | 42.9 |
| Pentobi level 5 | 48.1 | 44.1 | 42.5 |
| Pentobi level 7 | 50.9 | 45.5 | 43.3 |
| **Panel mean (each target weighs 1)** | **47.8** [47.1, 48.5] | **43.3** [42.9, 43.7] | **42.0** [41.6, 42.4] |

| Budget − pro (panel, paired by seed) | Δ squares [95% CI] |
|---|---|
| SQP-l6 | +5.76 [+5.06, +6.46] |
| SQP-l6x4 | +1.26 [+0.79, +1.73] |

Rule (fixed in advance): the smallest budget whose panel mean is within 1.0 square of pro's.
Note: pro still takes more than a square more than l6x4, so a larger adversary would probably squeeze harder still.

**Selected budget: pro**  (freeze with: engine-rs/scripts/squeeze-run.sh freeze SQP pro)
