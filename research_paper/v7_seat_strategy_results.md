# v7 seat-strategy confirmation — results

Run 2026-11-13 on this PC, after the preregistration in
`research_paper/v7_seat_strategy_preregistered.md`. The mirror was already complete and was not
replayed. `agg140` then `flat` played 1,600 seeds from 75,000,000 at budget 300, seat-rotated,
against `v4.2-ultra`. Each arm took about 63 minutes on 15 threads. Tables:
`ml/seat/results/v7-agg140.txt`, `ml/seat/results/v7-flat.txt`.

The gated number is the paired change in win share for the target seat, in percentage points.

| Hypothesis | Seat | Change | 95% CI | Gate |
|---|---|---:|---|---|
| H1 `agg140` | blue | +3.65 | [+0.60, +6.67] | pass |
| H2 `flat` | yellow | −1.14 | [−3.38, +1.10] | fail |

H1 also raised blue's advantage, +0.82 [+0.21, +1.43]. The screen's +7.2 pp shrank to +3.65, and
the other three seats moved by less than their intervals. Overall first-place share was 25.7%.

H2's screen estimate was +3.6 pp and the confirmation point estimate changed sign. The interval
includes 0, which the preregistration already called underpowered: this is "not shown", and the
sign change means it is not a near miss of the screened effect. Overall first-place share was
24.3%. Yellow's advantage change was −0.37 [−0.79, +0.06].

## What follows

Only H1 passed, so the combined config is `agg140` from blue and `v4.2-ultra` from the other
three seats. Shipping it still needs root-seat dispatch that stays byte-identical when unused,
then a promotion match on a fresh block fixed in an addendum before any game. That match is not
part of this run.
