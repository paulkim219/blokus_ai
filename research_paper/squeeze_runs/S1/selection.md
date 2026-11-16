## S1: adversary arms at the level-6 budget (/home/paulk/Blokee/research_paper/squeeze_runs/S1); mean target squares placed of 89, lower is a stronger squeeze

| Target | `SQ0-l6` | `SQR-l6` | `SQP-l6` | `SQRP-l6` |
|---|---:|---:|---:|---:|
| v5.2-nano | 62.2 | 62.8 | 45.4 | 46.0 |
| v5.2-lite | 62.5 | 62.2 | 44.0 | 47.1 |
| v5.2 | 69.3 | 70.0 | 47.7 | 47.8 |
| v5.2-pro | 75.0 | 74.2 | 51.1 | 53.1 |
| Pentobi level 1 | 56.4 | 55.0 | 43.3 | 43.0 |
| Pentobi level 3 | 59.8 | 61.7 | 45.4 | 44.7 |
| Pentobi level 5 | 67.7 | 66.3 | 48.1 | 47.8 |
| Pentobi level 7 | 73.7 | 72.4 | 50.8 | 50.7 |
| **Panel mean (each target weighs 1)** | **65.8** [65.0, 66.6] | **65.6** [64.7, 66.5] | **47.0** [46.4, 47.6] | **47.5** [46.9, 48.1] |

| Arm − SQ0 (panel, paired by seed) | Δ squares [95% CI] |
|---|---|
| SQR-l6 | -0.22 [-1.26, +0.81] |
| SQP-l6 | -18.81 [-19.76, -17.89] |
| SQRP-l6 | -18.28 [-19.20, -17.36] |

Rule (fixed in advance): the arm with the lowest panel mean among those that take significantly more squares than SQ0 (upper bound below 0), else SQ0.

**Selected arm: SQP**
