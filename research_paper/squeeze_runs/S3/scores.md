## Squeeze scores against `squeeze-v1` (/home/paulk/Blokee/research_paper/squeeze_runs/S3)

| Target | Seeds | Squares placed of 89 [95% CI] | Pieces of 21 | All 21 placed | Last placement (ply) | Squares by seat (blue / yellow / purple / green) |
|---|---:|---|---:|---:|---:|---|
| v5.2-nano | 100 | **40.2** [39.7, 40.8] | 9.6 | 0.0% | 36 | 40.2 / 37.5 / 40.1 / 43.0 |
| v5.2-lite | 100 | **41.3** [40.7, 41.8] | 9.8 | 0.0% | 37 | 41.6 / 39.4 / 40.2 / 43.9 |
| v5.2 | 100 | **42.5** [42.0, 43.1] | 10.2 | 0.0% | 38 | 42.1 / 40.2 / 41.9 / 46.0 |
| v5.2-l6 | 100 | **42.8** [42.2, 43.3] | 10.3 | 0.0% | 39 | 42.9 / 40.4 / 41.7 / 46.2 |
| v5.2-pro | 100 | **44.2** [43.6, 44.8] | 10.7 | 0.0% | 40 | 46.6 / 40.5 / 43.2 / 46.4 |
| Pentobi level 1 | 100 | **41.0** [40.6, 41.4] | 9.7 | 0.0% | 36 | 42.5 / 35.7 / 41.1 / 44.6 |
| Pentobi level 2 | 100 | **42.1** [41.6, 42.6] | 10.0 | 0.0% | 37 | 44.5 / 36.0 / 42.0 / 45.8 |
| Pentobi level 3 | 100 | **42.9** [42.2, 43.5] | 10.2 | 0.0% | 38 | 45.4 / 37.1 / 42.7 / 46.1 |
| Pentobi level 4 | 100 | **43.6** [43.0, 44.2] | 10.4 | 0.0% | 39 | 45.8 / 37.2 / 44.1 / 47.3 |
| Pentobi level 5 | 100 | **43.7** [43.1, 44.4] | 10.5 | 0.0% | 40 | 45.6 / 38.0 / 44.6 / 46.6 |
| Pentobi level 6 | 100 | **44.2** [43.6, 44.8] | 10.6 | 0.0% | 40 | 47.2 / 37.7 / 44.9 / 46.9 |
| Pentobi level 7 | 100 | **44.4** [43.7, 45.1] | 10.7 | 0.0% | 40 | 45.5 / 38.3 / 46.2 / 47.6 |

## Validity check 1: the same targets against three ordinary seats (same seeds)

| Target | Seeds | Ordinary opponents | Squeeze adversary | Squeeze − ordinary [95% CI] |
|---|---:|---|---|---|
| Pentobi level 5 | 100 | 71.7 | 43.7 | **-27.9** [-29.0, -26.9] |
| v5.2 | 100 | 69.6 | 42.5 | **-27.1** [-28.1, -25.9] |

The benchmark is used only if the squeeze takes clearly more than 5 squares off `v5.2` here.
