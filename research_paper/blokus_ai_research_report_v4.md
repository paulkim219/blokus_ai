# Designing a Strong Automated Agent for Four-Player Blokus

## Revision 4 — rewritten against measurement

---

## §0. How to read this document, and where strength actually comes from

Revision 3 was a design document. It was implemented in full, measured against an incumbent engine
over roughly 40,000 games, and about a third of its specific recommendations turned out to be wrong
or immaterial. This revision keeps what survived, corrects what did not, and — most importantly —
**tags every claim with what supports it**, because revision 3's central failure was not any single
bad recommendation. It was that untested assertions and established results were written in the same
voice.

| Tag | Meaning |
| --- | --- |
| `MEASURED` | Measured in the reference implementation, with the number. |
| `LITERATURE` | Established elsewhere; transfer to this domain is an assumption unless tagged otherwise. |
| `STRUCTURAL` | Follows from the rules or the code; no experiment needed. |
| `HYPOTHESIS` | Not established. The experiment that would settle it is named. |

### 0.1 The single most important empirical fact

`MEASURED` In the reference implementation, **how a leaf's value is obtained, and the evaluation
weights, decide outcomes. The tree policy barely registers.**

That phrasing is deliberate and was arrived at the hard way. An earlier draft said "architecture
barely registers", which its own falsifier in §8 then contradicted: playout length is a search-side
change worth +4.73 at equal compute. The distinction that survives the data is **leaf estimation**
(how a rollout terminates and what value it returns — worth +4.7) and **evaluation weights** (worth
+4.5) against **tree policy** (selection rule, widening, transpositions, opponent model, shortlists,
exploration constant — all null or small).

| Change | Class | Effect vs baseline |
| --- | --- | --- |
| Playing rollouts to the end rather than truncating at 12 plies | leaf estimation | **+4.73** (equal compute) |
| Fitting evaluation weights by CEM self-play (structure unchanged) | weights | **+4.5** |
| Fractional tie-break in the territory statistic | feature computation | +0.96 |
| Value-function scale, five-fold sweep | leaf estimation | null |
| Rank/margin blend | leaf estimation | null |
| PUCT with a heuristic prior, as a standalone change | tree policy | −1.03 |
| Progressive widening at the root | tree policy | +1.96 — **interval spans zero; replicate before citing** |
| Exact endgame packer | tree policy | +0.01 |
| Seat-conditioned weights, as guessed constants | weights | −0.10 |

Revision 3 devoted roughly 60% of its length to algorithm selection and architecture (§2, §6) and
disposed of the weights in a subordinate clause — *"tuned by self-play or CMA-ES"*. That allocation
was backwards. **The features are the prior; the weights and the simulation policy are the engine.**

### 0.2 A cost model is mandatory

`STRUCTURAL` Every recommendation below carries a cost per search iteration and the share of a
300-iteration-per-move budget it consumes. Revision 3 stated none, and the consequence was concrete:
its Δsplit term was specified as an O(regions) computation per candidate with a branching factor in
the high hundreds, so any implementation must pre-filter — and the obvious cheap pre-filter (piece
size) removes exactly the small-piece cut moves that Δsplit exists to surface. A recommendation
without a budget is a recommendation whose implementation is unspecified.

### 0.3 Adopt incrementally; never compare an untuned engine with a tuned one

`MEASURED` The reference implementation of revision 3 scored **−2.84** against the incumbent. Fitting
its weights — no structural change — recovered **+1.83** of that. Comparing a fresh design against a
tuned incumbent therefore starts with a ~2-point handicap that has nothing to do with the design.

This document should be implemented **one mechanism at a time onto the measured champion**, each with
a single-axis ablation, and nothing should be compared until it has been through the same fitting the
incumbent had. A full-stack replacement forfeits every fitted parameter and makes attribution
impossible.

### 0.4 An ablation is only valid inside the regime it was measured in

`MEASURED` Four results in the reference implementation reversed when an unrelated parameter changed.
When playouts were truncated at 12 plies, pooling playout candidates from four open corners instead
of one was worth **+0.75**; once playouts ran to the end it was worth **−0.10 [−0.62, 0.42]**. The
mechanism is clear in hindsight — over ~80 plies to a real score, local policy errors average out —
but nothing in the ablation itself announced its own regime dependence. Record the configuration
alongside every number.

---

## 1. The computational character of Blokus

Blokus is played on a 20×20 grid by four players, each holding the 21 free polyominoes of size one
through five (89 squares). A piece may be placed only if it touches at least one same-colour piece
corner-to-corner and no same-colour piece edge-to-edge; the first piece must cover the player's home
corner. Final score is the negative of the squares left unplaced, +15 for placing everything and +5
more if the monomino goes last.

**Branching factor.** `MEASURED` Counting fixed orientations there are 91 one-sided polyominoes of
size one to five. In the reference implementation the per-turn legal move count peaks in the high
hundreds around plies four to eight and decays to single digits in the endgame. Games last at most 84
plies. The tree is wide-then-narrow.

**Weak opponent coupling with heavy spatial locality.** `STRUCTURAL` Interaction is mediated entirely
through the shared board; once regions are sealed the game decomposes into independent packing
sub-problems. The two adjacent-corner opponents are met early along the edges, the diagonal opponent
later in the centre.

**Score, not win/loss — and you must say which.** `MEASURED` This is where revision 3 went wrong at
the very first step. It observed that "the maximand is ambiguous (win, rank, margin, or raw score)"
and then left it ambiguous, later prescribing a rank/margin blend. **The maximand is not ambiguous;
it is whatever the evaluation harness scores, and the engine's value function must match it.**

In the reference harness the statistic is `score − mean(the other three)`. The implementation, reading
revision 3, backed up a sigmoid of the margin against the *best* opponent blended with a rank term.
Switching to the mean measured **+0.52 [−0.21, 1.31]** — free and correctly aligned, though not large.
The lesson is not the size of the effect; it is that a two-player result (Shibahara & Kotani's
sigmoid, from Blokus **Duo**) does not transfer without choosing an aggregation over three opponents,
and revision 3 did not notice a choice was being made.

---

## 2. Algorithm selection

### 2.1 Candidates

`LITERATURE` Max^n (Luckhardt & Irani, 1986) holds a utility vector per node and each player
maximises their own component; correct for non-cooperative n-player games but admits only shallow
pruning (Sturtevant & Korf, 2000). Paranoid collapses the game to two players, enabling full
alpha-beta at the cost of a pessimistic model. Best Reply Search (Schadd & Winands, 2011) considers
only the single most damaging opponent reply. Multi-player MCTS backs a score vector up every node
with each player selecting on their own component (Cazenave, 2008; Sturtevant, 2008; Nijssen &
Winands, 2011).

`MEASURED` In the reference implementation the choice among these mattered far less than the
literature suggests. Switching the opponent model from max^n to paranoid-when-leading measured
**+0.52 [−0.21, 1.31]**; the BRS variant was not separable from noise. **Do not spend design effort
here.** Use max^n vector backup, which is the least-wrong model and the simplest to implement, and
spend the effort on §2.2 instead.

### 2.2 Playouts — the largest single decision in the design

This section replaces revision 3's recommendation, which was the worst error in the document.

Revision 3 said: *"Random playouts in Blokus are informative because the scoring rule is simple, and
they can be truncated after a fixed number of plies with a heuristic evaluation (early playout
termination, in the manner of Lorentz), which is far cheaper than a well-tuned static evaluator."* It
then specified truncation at ~12 plies.

`MEASURED` **Truncation is the single most expensive mistake available in this domain.** Sweeping the
cutoff, all else equal, 200 seeds / 800 games per point:

| Truncation depth | Advantage vs the 12-ply configuration | First place |
| --- | --- | --- |
| 12 plies (revision 3's recommendation) | — (baseline) | 25% |
| 18 | +1.29 [0.65, 1.92] | 34.3% |
| 24 | +3.57 [2.85, 4.31] | 45.0% |
| 36 | +5.13 [4.45, 5.86] | 50.0% |
| 48 | +4.89 [4.28, 5.50] | 46.9% |
| **84 (no truncation)** | **+5.71 [5.05, 6.35]** | **52.1%** |

`MEASURED` **This is a domain fact, not a property of this design.** The incumbent engine hard-coded
its own truncation at 24 plies (14 in self-play) — the same choice by a different route — and giving
*it* full-length rollouts is worth **+6.93 [4.74, 9.17]**, more than this design gained. Both engines
were independently leaving five to seven points on the table. Do not read the row in §0.1 as
something this design earned; read it as something the reference implementation surfaced because it
made the choice explicit enough to sweep.

`MEASURED` **Nor is it an artefact of unequal compute.** A full-length playout costs **1.3×** a
12-ply one per iteration — not several times, because a truncated leaf still pays for the composite
evaluation (a territory BFS and a region labelling) that a terminal leaf skips entirely. Re-run with
the full-playout configuration given 1/1.3 of the iteration budget, so the two meet at equal compute:
**+4.73 [4.10, 5.40]**, 48.8% first place. Roughly one point of the original 5.71 was the extra
compute; the rest is the change itself.

**Play the rollout to the end.** Revision 3 contradicted itself within a single paragraph: if playouts
are informative *because the scoring rule is simple*, truncating them and substituting a heuristic
discards precisely that informativeness. Twelve plies is three moves per seat — far too few for the
material consequences of a placement to appear.

`STRUCTURAL` The Lorentz early-termination result does not transfer because its premise does not hold
here. Early termination pays in games where a rollout is long and an evaluation is cheap. A Blokus
rollout is bounded at 84 plies and, on bitboards, costs *less* than the composite evaluation that was
replacing it. Check that premise before importing the technique.

`MEASURED` The simulation policy itself matters much less than its length. An ε-greedy policy on piece
size and centre distance is sufficient; enriching the candidate pool measured **−0.10 [−0.62, 0.42]**
once playouts ran to the end. Keep ε ≈ 0.15 and keep the policy blunt.

### 2.3 Recommendation

A multi-player MCTS with max^n vector backup, heuristic move ordering as a PUCT prior, **full-length
playouts**, and score-based backup. Exact search in the endgame is available (§4.3) but see the
measurement there before budgeting for it.

---

## 3. Heuristic evaluation

Notation: for player *i*, *S_i* squares placed, *R_i* remaining pieces, *C_i* open corner cells, *T_i*
Voronoi territory.

### 3.1 Territory and mobility

**Corner count and its transform.** `MEASURED` The open-corner count is the most predictive single
cheap feature, and the diminishing-returns transform revision 3 recommended is **correct and worth
keeping**: `f(C_i) = Σ over empty regions of (corners in region)^p` with *p* ≈ 0.5. Replacing it with
a linear count, rescaled to preserve magnitude, measured **−1.33 [−1.70, −0.95]**. Make *p* a fitted
parameter; fitting placed it at 0.44–0.48, close to the recommended 0.5.

**Territory, and how ties are broken.** Compute a multi-source shortest-path map *d_i(c)* from each
player's open corners over empty cells; diagonal steps through empty cells, orthogonal steps only onto
cells not edge-adjacent to that player's own colour. Then
*T_i = { c empty : d_i(c) < d_j(c) for all j ≠ i }*.

`MEASURED` **Split tied cells fractionally, 1/k among the k tied players — do not award them whole to
the earliest mover.** Revision 3 specified winner-take-all with a turn-order tie-break. That makes
|T_i| jump by whole regions between sibling moves differing by one placement, and those jumps are
noise with respect to the outcome. Splitting them measured **+0.96 [0.57, 1.37]** — the largest
evaluation-side gain found, and larger than several features the document spent pages on.

`STRUCTURAL` Retain the turn-order winner as the *owner* of each cell for any term that needs a
definite owner (§3.2's waste), while splitting only the counts.

**Legal move count |A_i| and frontier pressure.** `MEASURED` Revision 3 named both in prose and then
omitted both from its composite. Adding them back — as v11's proxies, `|C_i| + 2·|R_i|` and
"corners no opponent also holds" — measured **+0.35 [−0.62, 1.29]** fitted, and their partial
correlation with the eventual margin conditional on the composite is **+0.012** and **−0.015** over
12,864 positions.

Read that carefully, because it is weaker than it looks and an earlier draft overstated it. The
match result is a null at 100 seeds, which per §7 cannot distinguish an effect below ≈1.3 from zero.
The correlation result is *pooled* across positions, and §7 warns that pooled correlation measures
the ranking of unrelated positions while play depends on ranking siblings — so it cannot be used to
dismiss a feature either. **The honest statement is that neither feature is worth more than ~1.3
points, not that they carry no signal.** Either state the composite completely or do not name
features you will not include.

**Chokepoints as articulation points.** `LITERATURE` Build the empty-cell graph with 4-connectivity
and run Tarjan to find articulation points; occupying one splits a region. `STRUCTURAL` **Cost model:**
run Tarjan **once per node** (O(cells), microseconds), then a candidate is a cut candidate only if its
footprint intersects an articulation point — an O(piece size) test. Only that subset pays for the
region relabelling that scores the split. `MEASURED` With that costing, making the term reach interior
nodes measured **+0.24 [−0.50, 0.98]**: affordable, not significant, low priority.

### 3.2 Aggression, packing, and the composite

Model the value of candidate move *m* for player *i* as
*V_i(m) = Δown(m) + Σ_{j≠i} λ_j · Δharm_j(m)*, with λ_j a function of *j*'s standing and seat
relation rather than a constant.

**Waste.** Penalise empty cells in own territory that no remaining piece can fill. `MEASURED` This term
is worth **+0.59 [0.28, 0.90]** and should be kept. `STRUCTURAL` Note what it actually computes: since
strong play retains the monomino for the +5 bonus, the smallest remaining piece is size 1 for most of
the game and the test collapses to "cells in T_i orthogonally adjacent to my own colour" — own
frontier length inside own territory. That degenerate form is the useful one; those cells are
permanently unplayable by their owner and unreachable by anyone else. State it directly rather than
arriving at it by accident.

**A composite that is complete.**

  *E_i = a·S_i + b·f(C_i) + c·|T_i| − d·waste_i + e·centre_i − g·pressure_i − Σ_{j≠i} λ_j(h·|T_j| + k·f(C_j))*

`MEASURED` Opponent *material* is deliberately absent: adding `Σ_j λ_j · S_j` measured
**+0.35 [−0.62, 1.29]**, and it is structurally inert at one ply because opponents' placed squares do
not change when you move. `HYPOTHESIS` It may matter more inside a deep tree; untested.

**All coefficients are fitted, not chosen.** `MEASURED` This is the section's most important sentence
and revision 3 buried it. Hand-set values for these coefficients underperform fitted ones by ~1.8
points, and across fifteen attempts in the reference implementation **no hand-set change to a
coefficient ever improved the engine** — eleven measured null or negative. Every gain came from
changing what a term *computes*, never from changing what it is *worth*.

---

## 4. Phase-specific strategy

`MEASURED` A phase schedule is worth **+1.02 [0.67, 1.37]** and is the clearest structural win in the
evaluation. Prefer a **continuously interpolated** schedule over discrete buckets: the interpolated
form is the one that measured, and discrete buckets make the objective jump between successive plies.

**Opening (own moves 1–5).** Weight corner count and centre reachability; play pentominoes; fan into
two or three corridors. `MEASURED` Blocking is worth little here. `HYPOTHESIS` An opening book from
long offline searches is cheap and effective; untested in the reference implementation.

**Mid-game (own moves 6–15).** Territory delineation and chokepoints; aggression coefficients highest,
and highest against the opponent whose Voronoi frontier with the agent is longest.

**Endgame (own moves 16–21).** Packing efficiency dominates.

### 4.3 Exact endgame packing — demoted

Once a player's reachable region is disjoint from every opponent's, the position is a deterministic
maximum-weight packing under the corner rule, solvable by memoised branch-and-bound on (region
bitboard, remaining-piece mask) with a bound of min(coverable cells, Σ remaining sizes).

`MEASURED` **It is worth +0.01 [−0.00, 0.03].** Sealed regions are rare and arrive so late that exact
packing rarely differs from what a full-length rollout already finds. Revision 3 gave this one of its
longest sections. Implement it if you want provable endgame play; do not budget strength for it.

`STRUCTURAL` The ILP formulation is worth keeping as an *offline validator* of the branch-and-bound
solver and nothing more. Exhaustive enumeration on small regions serves the same purpose without a
MIP dependency.

---

## 5. Turn-order asymmetry

`STRUCTURAL` Every seat has two adjacent-corner opponents and one diagonal opponent; a corner you open
is exposed to three opposing plies before you can use it. Index seats by **turn order**, so "next",
"previous" and "diagonal" are `(s±1)` and `(s+2)`.

`MEASURED` **Seat-conditioned weights as design-time constants are worth nothing** (−0.10 [−0.36,
0.16]). Revision 3 proposed a per-seat weight vector with guessed values; those values measured as
noise. Seat conditioning is a **tuning axis**, not a set of constants — and when a fit was given 66
parameters of which 20 were seat multipliers, dropping the seat dimension entirely did not hurt.

`STRUCTURAL` Revision 3 argued that the tempo tie-break in the territory map is where turn order
"genuinely enters" the evaluation. **That is no longer true of the recommended design.** §3.1 now
splits tied cells 1/k regardless of turn order, which measured +0.96 — so the tempo idea has been
removed from the statistic that was its main carrier, and turn order now enters only through the λ
relations and the seat multipliers, neither of which has measured as worth anything.

`HYPOTHESIS` An order-weighted split (shares proportional to how soon each tied player moves, rather
than equal 1/k) would restore the tempo idea without restoring the discontinuity. Untested, and the
obvious experiment.

`HYPOTHESIS` The first-mover advantage this section assumes has never been measured here, and it is
free: mean score by seat across any mirror match already gives it. Do that before conditioning
anything on it.

`HYPOTHESIS` The λ machinery — aggression coefficients by seat relation and standing, which §3.2
carries throughout — **has never been ablated.** Set λ = 0 and measure.

---

## 6. Architecture

**Layer 0 — Representation.** Four 400-bit bitboards plus per-colour edge and corner haloes,
maintained incrementally. Open corners are `cornerHalo & ~occupied & ~edgeHalo`. Precompute a mask per
(piece, orientation, anchor) — ~27,000 of them — with a CSR index of which placements cover each cell;
generation then walks the open corners at two ANDs per candidate. `MEASURED` This representation is
~20% cheaper per move than an object-based board carrying a *richer* evaluation, and ~1.8× faster at
the one-ply policy.

`STRUCTURAL` **Build the bitboard generator with a slow reference implementation beside it and a
property test that they agree move-for-move.** This was revision 3's single most valuable sentence and
it stays: in the reference implementation it caught two real bugs during construction.

**Transpositions.** `HYPOTHESIS` Revision 3 asserted transpositions are "unusually common". This was
never quantified and remains unquantified; the DAG machinery it motivates costs a hash lookup per node
and forces a choice between edge and node visit counts in the exploration term (Childs et al., 2008;
Saffidine et al., 2012). Measure the hit rate before building it.

**Layer 2 — Search controller.** Detect phase, load weights, consult the book in the opening, call the
exact packer on sealed regions, otherwise MCTS with PUCT priors, progressive widening, and
**full-length playouts**. `MEASURED` Widening the interior candidate shortlist from 24 to 48 measured
+0.21 [−0.44, 0.85]; the shortlist is not a bottleneck.

**Layer 3 — Learning.** `HYPOTHESIS` A policy-value network remains the strongest option in principle
and is untested here. Note that §0.1 makes the prior claim on effort: fitting a linear evaluation was
worth +4.5, and that is the floor a network must clear.

---

## 7. Evaluation and testing

This section is rewritten around the protocol that actually worked, and it is the part of revision 3
most worth replacing.

**The statistic must have a zero null.** `STRUCTURAL` Score each seed by rotating the challenger through
all four seats while the incumbent fills the rest, and report `challenger − mean(the three incumbent
seats)`, averaged over the four rotations. With two identical configurations all four rotations are
the same game and the advantages cancel exactly, so **a mirror match must print 0.00**. Check it; a
statistic like `hero − max(opponents)` has a *negative* null and will make every challenger look bad.

**Pair on common random numbers.** Seed every stochastic choice so two configurations meet identical
rollout luck.

**State the minimum detectable effect beside every null.** `MEASURED` The per-seed standard
deviation of the rotation statistic is ≈4.8 in this harness, so the smallest effect an experiment can
distinguish from zero at 80% power is ≈13.4/√(seeds):

| Seeds | 24 | 48 | 60 | 100 | 200 | 400 |
| --- | --- | --- | --- | --- | --- | --- |
| Minimum detectable effect | 2.7 | 1.9 | 1.7 | 1.3 | 0.95 | 0.67 |

A null at 60 seeds does not mean "no effect"; it means "no effect larger than about 1.7". Several
conclusions in earlier drafts of this work read underpowered nulls as absences, and the intervals
admitted effects big enough to matter.

**Bootstrap over seeds, not games.** `STRUCTURAL` The four rotations of a seed are one sample. A
100-game run is 25 samples, and its interval is correspondingly wide — wide enough, in the reference
implementation, to hide a four-point effect and produce a confidently wrong conclusion that had to be
retracted.

**Run the determinism gate at every policy.** `MEASURED` A one-ply policy can be deterministic by
construction while the tree is not. Gate both.

**Held out means held out.** `MEASURED` A tuner drawing generation *g*'s seeds from `g·100000 + i`
collides with any validation base that is a multiple of 100,000. Check the lattice.

**Never quote a tuner's own fitness.** `MEASURED` Generation-best is the maximum over a population on a
shared seed block and is optimistically biased — by **2.3 points** at 24 seeds per candidate, and ~1.0
at 96. Validate on held-out seeds or do not report a number.

**Fit each parameter under a policy that reads it.** `MEASURED` Fitting leaf-value parameters at a
one-ply policy applies no fitness pressure at all — that policy never evaluates a leaf — so they drift
under selection noise. Partition the parameter space by which policy exercises it.

**Three tiers.** Unit and property tests (generator equivalence, incremental-state consistency,
exact-solver agreement); oracle-labelled per-ply loss against a **common** oracle, since an engine
judged by its own long-time-control self measures consistency rather than quality; and seat-rotated
tournament statistics.

**Diagnostics that cost seconds rather than games.** `MEASURED` Two were worth more than any match in
localising problems:

- **Position-level correlation.** Score logged positions with each evaluation and correlate against the
  margin the game actually ended on, by phase. This showed the reference evaluation was a *better*
  global predictor than the incumbent's while losing head-to-head — which localises the fault to
  sibling discrimination rather than position assessment.
- **Within-node variance decomposition.** For sampled nodes, score every legal child and report each
  term's standard deviation across siblings as a share of the total's. A term with negligible
  within-node variance cannot affect play whatever its weight, and its weight is unidentifiable to any
  play-based tuner.

`MEASURED` Both are diagnostics, not oracles. Where they and the tuner disagreed, the tuner was right:
acting on a partial-correlation prescription measured null twice.

---

## 8. What is established and what is not

`MEASURED` The reference implementation of this design reached **−0.55 [−1.32, 0.20]** against the
tuned incumbent over 800 held-out games, from a starting point of −2.84, via fitted evaluation
weights (+1.83), the fractional territory tie-break (+0.86) and full-length playouts.

**That apparent parity was an artefact and is withdrawn.** The incumbent had its own truncation
hard-coded at 24 plies; it had simply never been exposed as a parameter. Give it the same fix and it
gains **+6.93 [4.74, 9.17]** — more than this design gained. Run the two corrected engines against
each other and this design loses by **−4.45 [−5.89, −2.97]** (40 seeds at 100 iterations; the
minimum detectable effect there is 1.9, so the deficit is real at that budget, though it has not been
confirmed at 300).

**The honest accounting is therefore:**

| Contribution | Class | Worth |
| --- | --- | --- |
| Full-length rollouts | **domain fact, not this design's** | +4.7 to +6.9 to *any* engine here |
| Fractional territory tie-break | this design | +0.96 |
| Bitboard representation | this design | ~20% cheaper per move |
| Making the truncation choice an explicit parameter | this design, indirectly | the reason the domain fact was found at all |
| The evaluation `E_i`, once both engines are corrected | this design | **~4.5 points worse than the incumbent's** |

The evaluation is the part of this document that most wanted to be true and is least supported. It is
the best *hand-designed* evaluation this project has produced, it is worth +1.41 as a search prior,
and it is still materially behind a fitted linear evaluation over a longer-standing feature set. §0.3
said to adopt one mechanism at a time onto the measured champion; had that been followed, the
truncation fix would have been found in an afternoon and the rest of this engine would never have
been built.

**Open questions, with the experiment that settles each:**

1. `MEASURED` **The value-function scale is not a lever.** Sweeping it at the tree policy against the
   shipping value, 100 seeds per point: 6 → −0.24 [−0.98, 0.51]; 20 → +0.19 [−0.81, 1.22]; 30 →
   −0.77 [−1.56, 0.05]. Flat across a five-fold range. The rank blend, the other half of the same
   lever, is null too: 0 vs the shipping 0.35 measures +0.28 [−0.35, 0.93]. **Both parameters became
   live when playouts stopped being truncated, and the engine is insensitive to both** — the
   mechanism was right and the consequence was not.
2. `HYPOTHESIS` The tree's own parameters — exploration constant, prior temperature, widening schedule,
   ε — remain at their originally guessed values. *Fit them; they have never been searched.*
3. `HYPOTHESIS` The evaluation was fitted for one-ply ranking but now serves only as a move-ordering
   prior. *Re-fit it in that role.*
4. `HYPOTHESIS` Transposition frequency at tournament depth is unmeasured (§6).

**What would falsify the central claim of §0.1** — that leaf estimation and weights dominate while
*tree policy* does not — is a **tree-policy** change worth more than ~+4.5 in this harness. Playout
length is not a counter-example: it is leaf estimation, and §0.1 now classifies it that way rather
than claiming it away. None has been found in sixteen attempts, but the tree parameters in (2) have
never been fitted, so the claim is not yet safe.

---

## 9. Generation 4 audit and the generation 3.2 programme

This section was added after the first learned evaluator and the high-compute v3.1 tiers were built.
It separates two jobs that the first v4 experiment accidentally conflated: learning a **policy**
that ranks moves, and learning a **value** that replaces a terminal rollout.

### 9.1 What the first v4 experiment actually established

`MEASURED` The 168-feature MLP is not a usable leaf replacement in its present form. Against v3.1
at 300 base iterations, using it for 100% of the leaf value measured **−10.62 [−12.10, −9.23]**;
50% measured −1.73 [−3.24, −0.21]; 25% measured −0.47 [−1.90, 1.09]. As a root prior only it
measured −0.58 [−1.35, 0.23] over 400 games. The monotone damage as leaf weight increases is strong
evidence that the current learned value is biased relative to a full rollout. It is not evidence
that learning is intrinsically unsuitable for Blokus.

`MEASURED` The saved model was trained on 323,595 child rows in 28,484 sibling groups and reached
0.563 held-out pairwise agreement with searched child values. More rows and a larger model did not
move that result materially. A repeated-search diagnostic measured 64.5% agreement between the
teacher's pairwise value ordering, so the labels themselves are noisy.

`MEASURED` Correcting the double-margin contract under a new id did not rescue the value model:
`v4-margin-corrected` measured **−8.66 [−10.09, −7.18]** against v3.1 over 100 held-out games.
This is directionally less negative than the original −10.62, but the two experiments used different
seed blocks, so the difference must not be claimed as a causal +1.96 gain. The clean conclusion is
that the contract bug was real and was not the dominant source of failure.

`STRUCTURAL` Three contract problems must be fixed before interpreting another model comparison:

1. The value targets are already `score_i − mean(other three)`, but the original inference path
   treated them as raw per-seat scores and subtracted an opponent reference again. Preserve the
   measured `v4` config, and test the corrected contract under a new id.
2. The engine plays the most-visited root child, while the policy loss imitates the child's mean
   searched value. These are different targets. AlphaGo Zero trains its policy on the MCTS visit
   distribution, not on a ranking of noisy Q estimates; the exporter must record visits and the
   policy head must learn them. See [Silver et al. (2017)](https://discovery.ucl.ac.uk/id/eprint/10045895/).
3. The teacher-noise diagnostic compared a visit-selected move from one run with a highest-value
   move from the other. Its pairwise-value agreement remains meaningful, but the reported
   best-move agreement did not compare like with like. `MEASURED` After correction, a preliminary
   three-game repeat over 73 positions measured **52.1%** agreement on the visit-selected move and
   **67.8%** agreement over 1,754 shared sibling-Q pairs (74.9% for pairs separated by more than one
   point). The teacher is still noisy, but the withdrawn 25.8% figure overstated it substantially.

`STRUCTURAL` A single state network should not be asked to serve both jobs. A policy model needs
`P(s,a)` and therefore action-conditioned information: piece identity and orientation, footprint,
created/denied corners, articulation contact, and per-seat deltas in reachable area, territory and
waste. A value model needs `V(s)` and final outcomes. Of the current 168 child-state features, only
45 vary between siblings; the rest may help value prediction but cannot help a within-node policy
loss.

### 9.2 Recommended v4 continuation

Call the next experiment v4.1 until it wins; do not promote the generation number on architecture
alone.

1. **Fix the contracts first.** Directly squash predicted mean-opponent margins; export each root
   child's visit count; re-run the corrected teacher-consistency diagnostic.
2. **Split policy and value.** Train `P(s,a)` from `log(1 + visits)` (or the normalised visit
   distribution) and `V(s)` from final four-seat outcomes. Do not use the policy loss as evidence
   that the same network is a calibrated leaf value.
3. **Improve targets before capacity.** Generate policy labels with the current strongest teacher,
   v3.1-pro-max, and average several independently seeded searches for a smaller set of positions.
   For the value model, prefer many final outcomes and a Huber loss; search-Q distillation bakes one
   rollout draw into every label.
4. **Make the policy input local and differential.** Start with a small action-conditioned MLP over
   parent features plus move deltas. Only move to a spatial model if it wins the offline sibling
   test; the existing raw-board probe did not.
5. **Gate deployment.** A policy candidate must first beat the hand prior offline by phase, then
   beat it as a root prior at equal compute. A value candidate must reduce held-out outcome error
   and survive 25% and 50% blends before it is allowed to replace rollouts.
6. **Close the loop only after both heads work independently.** Then generate fresh self-play with
   the improved policy/value pair, retain a replay buffer containing older opponents, and promote
   only on held-out seat-rotated matches. The multiplayer value remains a four-component vector;
   [Petosa & Balch (2019)](https://arxiv.org/abs/1910.13012) is precedent for adapting the
   AlphaZero loop to multiplayer play, not proof that its choices transfer here.

### 9.3 What should qualify as v3.2

`MEASURED` At the current top tier, v3.1-pro-max scores **+2.71 [1.73, 3.71]** against v2-pro and
1.02 [0.24, 1.84] against v3.1-pro. Narrowing the rollout candidate cap from 12 to 6 is null
(−0.11 [−0.86, 0.65]). The next version should therefore improve how a fixed number of terminal
samples is allocated or combined, not merely add iterations or widen the rollout.

The recommended v3.2 ablation ladder is:

1. **Root sequential halving.** The shipped decision is a fixed-budget best-arm problem over a wide
   root. Allocate equal samples, remove the bottom half, and repeat, while leaving interior max^n
   search and full rollouts unchanged. This directly targets simple regret and root instability.
   Sequential Halving has a fixed-budget best-arm basis in
   [Karnin, Koren & Somekh (2013)](https://proceedings.mlr.press/v28/karnin13.html), and the later
   Gumbel planning work reports gains at low simulation counts
   ([Danihelka et al., 2022](https://openreview.net/forum?id=bERaNdoegnO)). Start without Gumbel
   noise in tournament play so the single-axis change is the allocation schedule.
2. **Implicit minimax/max^n guidance.** Store the terminal-rollout mean and the deterministic
   heuristic backup separately; blend them only in selection, never in the returned leaf value.
   This is importantly different from v4-hybrid, which biased the backed-up sample itself. Sweep
   α ∈ {0.05, 0.10, 0.20, 0.30}; the method is described by
   [Lanctot et al. (2014)](https://arxiv.org/abs/1406.0486).
3. **Fit the tree in the regime that ships.** Sweep `cPuct`, prior temperature, widening growth and
   progressive-history weight one axis at a time on v3.1-pro-max, with at least 200 seeds for the
   final two candidates. These values are still inherited guesses; fitting evaluation weights at a
   greedy policy did not fit the tree.
4. **Instrument before optimising transpositions.** Report lookup count, true hit count, number of
   nodes with multiple parents and time spent hashing. Disable DAG sharing if the hit rate does not
   repay the lookup and shared-statistics complexity; do not infer that from literature.
5. **Add a compute-matched opening book last.** Build it from repeated v3.1-pro-max searches and
   require stability across seeds. It is a strength feature but not evidence about the tree policy,
   so keep its result separate from steps 1–4.

Do not spend the v3.2 budget on wider playouts, guessed seat weights, exact sealed-region packing,
or a wholesale opponent-model rewrite: each is already null, negative, or too small in the measured
regime. A candidate earns the v3.2 name only after it beats v3.1-pro-max on held-out seeds at equal
wall-clock compute and reproduces on a second seed block.

### 9.4 v3.2 candidate experiments (2026-08-21)

`MEASURED` The ladder above was implemented and tested with fixed 300-iteration tournament
budgets, paired random seeds and four seat rotations per seed. Long-running tier matches used 400
games; exploratory screens used 48 or 160 games. Advantage is challenger score minus the mean of
the other three seats, with a 95% seed-bootstrap interval.

| Candidate | Tier / games | Advantage (95% CI) | Decision |
|---|---:|---:|---|
| Root Sequential Halving | standard / 160 | −0.43 [−1.71, 0.89] | No gain |
| Root Sequential Halving | pro / 400 | **−1.01 [−1.68, −0.31]** | Reject; significantly worse |
| Implicit maxⁿ, α=0.10 | standard / 160 | +0.14 [−1.07, 1.46] | No gain |
| Implicit maxⁿ, α=0.10 | pro / 400 | −0.05 [−0.82, 0.72] | No gain |
| Implicit maxⁿ, α=0.20 | pro / 160 | −0.35 [−1.46, 0.80] | No gain |
| Implicit maxⁿ, α=0.10 | pro-max / 400 | +0.22 [−0.52, 0.98] | No gain |
| `cPuct=1.2` held-out | pro / 400 | −0.32 [−0.94, 0.32] | Screen did not replicate |
| No transposition sharing | standard / 160 | +0.03 [−0.00, 0.08] | Behaviourally neutral |
| No transposition sharing | pro / 400 | −0.00 [−0.00, 0.00] | Behaviourally identical |
| No transposition sharing | pro-max / 400 | −0.00 [−0.00, 0.00] | Behaviourally identical |
| `cPuct=1.2` + no transpositions | pro / 400 | +0.40 [−0.36, 1.16] | Inconclusive |
| Above + implicit maxⁿ α=0.10 | pro / 160 | −0.25 [−1.46, 1.11] | No interaction gain |

The ten-arm tree screen did not produce a robust parameter improvement. Its apparent winner,
`cPuct=1.2`, scored +1.06 [−0.31, 2.39] over only 48 games, then scored −0.32 on 400 new held-out
games. Prior temperature 3 was significantly harmful (−2.93 [−4.61, −1.29]); the remaining arms
all had intervals spanning zero. This is a useful warning against promoting a screen winner without
a fresh seed block.

`MEASURED` A separate fixed-position timing check over three game phases, two repeats and 100 base
iterations measured no-transposition search at −8.6% wall time for standard, −0.9% for pro and
+3.3% for pro-max. Together with exact tournament-score equality at the larger tiers, this says
transposition sharing currently has no demonstrated playing-strength value, but the timing sample
is too noisy to claim a universal speedup. Disabling it is reasonable as a simplification after a
larger timing benchmark; it is not a reason to name a v3.2 strength release.

The opening-book candidate was not tournamented because `src/ai/bitboard/book.ts` contains the
lookup mechanism but no generated, seed-stable book corpus. An empty-book match would only compare
the baseline with itself. Generate and audit the corpus before running that experiment.

**Decision:** no tested candidate earns the v3.2 name. Keep v3.1-pro-max as the strength baseline.
The next v3-series work should either (a) benchmark and land no-transposition search as a small
v3.1 efficiency simplification, or (b) test a genuinely new, compute-matched root-allocation method
on held-out seed blocks. Continue v4 through the separate policy/value plan in §9.2 rather than
folding these null tree changes into its learning experiment.

### 9.5 Post-cliff combination experiments (2026-08-22)

`MEASURED` Three combinations from the post-cliff shortlist were implemented and matched against
v3.1-pro at the same 300 base iterations per move. Each match used 100 fresh seeds, four seat
rotations per seed and disjoint seed blocks (400 games per combination). The action-conditioned
policy was trained on 66,102 placement rows from 5,967 v3.1-pro-max root searches (82 games). Its
242 inputs comprise the existing 168 child-state features plus piece, orientation, placement
geometry and parent-to-child delta features. The visit-count target reached 60.98% held-out sibling
pair accuracy and 27.43% held-out root top-1 accuracy (uniform top-1 is about 9% at the measured
average root width of 11.1).

| Combination | Timing vs v3.1-pro | Advantage (95% CI) | Decision |
|---|---:|---:|---|
| Learned policy + paired root audit | −4.6% | **−1.09 [−1.77, −0.39]** | Reject; significantly worse |
| Paired audit + variance-adaptive racing | +0.2% | **−1.40 [−2.22, −0.62]** | Reject; significantly worse |
| Learned policy + spatial root groups | −4.0% | −0.61 [−1.32, 0.11] | No gain; trends worse |

The timing check used fixed positions from three game phases and is only a calibration sample, not
a universal speed claim. It nevertheless establishes that every candidate was within the requested
similar-or-lower compute band: the largest measured slowdown was 0.2%. The tournament intervals
therefore cannot be explained by buying less wall-clock search for the baseline.

The paired-audit result and the audit-plus-racing result together are evidence against the current
post-search audit design. Full terminal playouts from a few root children are not a better final
selector than v3.1's tree statistics, even when candidates share random rollout scenarios and the
budget is concentrated on close, uncertain arms. The likely failure is information loss: the audit
throws away the opponent-contingency structure accumulated below each root child and replaces it
with a small, noisy scalar sample.

The policy results require a narrower conclusion. Both policy matches change a second mechanism,
so they do not isolate the learned prior. Offline imitation accuracy did not transfer in either
combination, but this is not proof that the 242-feature policy is independently harmful. Likewise,
the spatial-group match only rejects the combination; its coarse 5×5-cell region buckets may pool
tactically incompatible placements. If this policy artifact is investigated further, run a
policy-only ablation against the hand prior before changing its training data or architecture.

**Decision:** none of the three combinations earns a v3.2 name, and no second confirmation block is
warranted. Retire the current root-audit branch. Preserve v3.1-pro-max as champion. The only clean
remaining v3-series ablation from this batch is learned-policy-only; otherwise the evidence now
favours moving effort to v4's separately trained policy/value pipeline rather than composing more
rules around the v3.1 search tree.

### 9.6 Eight-hour adaptive search: a reproducible v3.2 (2026-08-22)

`MEASURED` The post-cliff programme continued adaptively: small disjoint-seed screens advanced only
positive candidates, fresh confirmations rejected screen winners that did not reproduce, and the
largest blocks were reserved for candidates with a consistent direction. Every comparison kept the
same base iteration count and used the candidate's calibrated iteration scale at a similar or lower
compute cost. The complete chronological ledger, including log paths and stopped branches, is in
`research_paper/v32_eight_hour_shift.md`.

Most additional search mechanisms did not survive this protocol. An equal-compute two-tree ensemble
was significantly harmful at −2.99 points; root piece-family allocation scored −0.67; piece-diverse
widening scored −1.24; and first-play urgency was a structural no-op because progressive widening
immediately samples every newly opened child. A learned policy-only prior scored −0.59, while its
25% and 50% hand-prior blends and an endgame-only gate remained null. Piece-level RAVE scored +0.49
at equivalence 10 and −0.39 at equivalence 50, so neither dose advanced.

Several promising screens also collapsed under larger held-out blocks. Variance-tuned PUCT pooled
to +0.28 [−0.23, 0.80] over 156 seeds after its 100-seed block scored −0.11. Terminal-rollout
ε=0.30 pooled to +0.29 [−0.32, 0.91] after its decisive block scored +0.02. Exact-placement MAST
pooled to +0.33 [−0.40, 1.07] after its decisive block scored −0.02. These are useful nulls: each
idea had a plausible mechanism and an initially positive screen, yet none merits a release name.

The successful change was the simplest one: raise the uniform-random branch inside full terminal
rollouts from ε=0.15 to ε=0.60. At the pro tier its three disjoint blocks were +1.86, +1.17 and
+0.33, pooling to **+0.70 [0.10, 1.31]** over 156 seeds / 624 games. It transferred positively at
the standard tier (+0.77 over 40 seeds) and, critically, reproduced at pro-max:

- first pro-max block: **+1.38 [0.02, 2.91]**, 40 seeds / 160 games;
- independent pro-max replication: **+0.68 [−0.04, 1.42]**, 100 seeds / 400 games;
- pooled pro-max result: **+0.88 [0.25, 1.54]**, 140 seeds / 560 games, 30.9% first place.

Both independent pro-max point estimates are positive and the pooled interval excludes zero at the
same iteration budget. This satisfies §9.3's reproduce-before-promotion rule. Canonical `v3.2`,
`v3.2-pro`, and `v3.2-pro-max` therefore preserve the v3.1 architecture and compute tiers but use
ε=0.60 terminal rollouts. This is a strength release rather than a speed release: it changes the
bias/variance mixture of the simulated games without buying more tree iterations.

Two attribution checks narrow the interpretation. Fully uniform ε=1.00 rollouts scored only +0.36
[−1.32, 2.23], so the evidence favours an interior mixture rather than removing rollout knowledge.
Phase screens suggested that high opening randomness and low endgame randomness might be better,
but the winning schedule scored −0.10 [−0.27, 0.06] when directly confirmed against `v3.2-pro`.
Keep the simpler all-phase ε=0.60 configuration.

`MEASURED` The parallel v4.1 continuation exported 256 additional v3.1-pro-max teacher games as
eight independent shards (204,820 placement rows / 18,482 root groups). The old five shards plus
new A–G gave 245,251 training rows / 22,141 groups—3.7 times the old policy dataset—while the
entire 32-game H shard remained untouched. On that same H holdout, simply retraining the old mixed
policy/value objective made ranking worse: sibling pair accuracy fell from 60.44% to 58.41%, while
root top-1 stayed at 26.36%.

The training trace localised the failure: the auxiliary final-outcome anchor was competing with the
visit-ranking objective. A small shard-G tuning audit removed that anchor, keeping the 42,020-
parameter network and listwise visit target unchanged. On untouched H, this policy-only model
reached **61.45% sibling pair accuracy and 27.68% root top-1**, gains of 1.01 and 1.32 percentage
points over the old policy. Every phase improved; midgame top-1 rose from 20.74% to 22.46%, while
endgame pair accuracy rose from 68.67% to 70.76%. This is a valid offline v4.1 improvement and earns
one online prior test layered onto `v3.2-pro`; it is not yet a playing-strength claim.

The final deterministic online gate scored **+0.12 [−1.02, 1.36]** over 40 seeds / 160 games against
`v3.2-pro`, 26.9% first place. Its positive point estimate misses the +0.5 advancement gate and
remains statistically unresolved. Do not deploy it or spend a decisive block. The next clean v4
question is teacher quality: repeat the same data-volume experiment with `v3.2-pro-max` labels,
keeping teacher populations in separately auditable shards.

That controlled v4.2 repeat exported another 256 games (207,534 rows / 18,641 groups) from the newly
promoted `v3.2-pro-max`. It matched v4.1's original 82-game base, 224-game new training partition,
network, loss and held-out-shard protocol. On untouched v3.2 shard H, v4.1 scored 61.82% pair
accuracy / 29.81% root top-1; v4.2 scored **61.68% / 29.67%**. This is operationally flat: the
stronger teacher loses 0.14 percentage points of pair ordering and 0.13 points of top-1, with
opening accuracy worse and only midgame top-1 better. Do not run an online match. More games and this
modest teacher-strength increase have reached the current 242-feature policy's ceiling; the next v4
iteration needs a stronger action/state representation or a richer target, not another identical
distillation batch.

The architectural lesson is that the cliff was partly a rollout-model bias cliff. More elaborate
tree allocation, online move statistics and a modest learned prior did not improve the action
ordering at fixed compute. Injecting substantially more diversity into terminal games did. The next
v3-series experiment should therefore target *where rollout correlation comes from*—for example,
state-dependent ε learned from held-out search disagreement—rather than adding another root
selector. In parallel, v4 should continue as a distillation programme with whole-game held-out
shards and direct old-versus-new policy evaluation; offline ranking gains must still pass a search
tournament before deployment.

### 9.7 What a true v4 should look like

The 242-feature v4.1/v4.2 policy is action-conditioned only in a summary-statistic sense. It knows
the placed piece and orientation, absolute coordinates, the complete hands, the 168 features of the
resulting child, and 39 parent-to-child deltas. It still cannot see the board arrangement that
produced those summaries. Two moves can create the same number of corners and nearly the same
territory delta while one opens a durable diagonal lane and the other puts all of its corners next
to an opponent's immediate reply. Those rows are aliased to the MLP even though they are different
Blokus actions. Adding width cannot recover information that the input discarded.

`PROPOSED` The v4 policy should therefore be a **shared spatial state encoder plus a cheap action
scorer**, not a large network re-run independently on every child:

1. Encode the root once using seat-relative 20×20 planes: occupancy for all four seats, legal/open
   corners, own forbidden-edge cells, reachable or territory ownership, and empty-region identity or
   size. Concatenate exact remaining-piece masks and phase features after the spatial encoder.
2. Represent each candidate with a placement footprint, edge halo and corner halo plus piece and
   orientation embeddings. Pool the shared board embedding under those three masks. This directly
   exposes what the action covers, touches, blocks and creates while amortising the expensive board
   computation across every legal move.
3. Score the interaction between the state embedding and each action embedding. Keep this as a
   policy-only head at the root initially. A separate four-component state-only value head may be
   trained and gated later; it must not share a loss with the policy until both heads work alone.

`MEASURED` The existing raw-board probe is weak evidence for a hybrid rather than a board-only
network. On its older 60-game corpus (49,457 rows / 4,300 usable groups, searched-value rather than
visit targets), a ten-epoch repeat reached 54.69% held-out pair accuracy for the 168-feature MLP,
52.76% for the raw-board convolution, and 55.35% for board plus features. The combined gain was only
0.66 percentage points and is not a promotion result. More importantly, those board planes show the
child occupancy but do not mark which cells belong to the candidate action, so the experiment does
not test the proposed shared-state/action-mask architecture. Regenerate spatial data with an
explicit placement plane and consensus visits instead of scaling this probe.

A lower-risk intermediate, useful before implementing convolution in the browser, is an expanded
action-conditioned MLP. Add per-opponent counts for placement overlap with open corners, edge and
diagonal contact, newly created corners by region, and legal-placement counts by remaining piece
before and after the move. These are richer only if they preserve interaction information; another
global count such as total territory is not. The cost must be measured because enumerating every
piece's legal placements for every root child may erase the search benefit.

`STRUCTURAL` The audit also found a concrete coordinate-frame alias in the 242-feature contract.
Seats are rotated into relative order so the mover is always `s0`, but action anchors and centroids
remain in absolute board coordinates and the discarded seat identity is the only fact that could
say which physical corner is home. The same x/y therefore means “near home” for one colour and
“across the board” for another. An experimental 256-feature contract now preserves the old 242
inputs as a backward-compatible prefix and adds home-relative anchor/centroid coordinates, the
number of own diagonal connections, and separate edge, diagonal and covered-open-corner contacts
for each opponent. It is wired into export and root-prior inference but has no trained weights and
does not change any released version. A one-game export smoke test produced 216 finite rows in 73
sibling groups; the next step is a controlled old-versus-256-feature offline comparison.

The current policy target is also thinner than it appears. One 300-iteration stochastic search
produces one visit histogram. Near-tied children can swap order because of a few rollouts, while a
listwise loss treats that realised histogram as ground truth.

`MEASURED` A preliminary corrected diagnostic on two v3.2-pro games sampled 35 positions and
searched each position twice at 300 iterations. The independent searches selected the same best
move 62.9% of the time and agreed on 72.8% of 875 non-tied visit-pair orderings (73.9% when the first
run separated the pair by more than one visit). Their searched-value ordering agreed on 67.5% of
901 pairs. Compare this with v4.2's 61.68% visit-pair accuracy and 29.67% top-1 accuracy: target
noise is material, but particularly for top-1 it does not account for the model's whole deficit.
The sample is too small for a final ceiling estimate; repeat it over a held-out position corpus.

`PROPOSED` A stronger target pipeline should:

1. Search the same sampled root three or more times with independent seeds, take the union of the
   candidate sets, normalise visits within each run, and average those distributions. Store the
   between-run variance or top-action agreement as label confidence.
2. Train directly against the consensus probability distribution. Down-weight unstable roots and
   near-tied pairs instead of forcing the network to memorise their accidental order. Retain hard
   negatives below the teacher's top set so a future all-legal-move policy learns more than the old
   heuristic shortlist.
3. Evaluate the quantity deployment needs: top-1 agreement, probability mass captured by the
   model's selected action, and teacher regret of that action, all reported by phase. Pairwise
   accuracy gives equal credit to inconsequential bottom-of-list swaps and should remain diagnostic,
   not the promotion metric.
4. Keep outcome learning separate. Train `V(s)` on completed-game four-seat margins, ideally with
   repeated continuations from sampled states and a robust loss. A root-visit target says which move
   search preferred; it does not make the same output a calibrated terminal-rollout replacement.

This gives a staged definition of v4 rather than a generation label attached to an MLP. **v4.3** is
the target experiment: measure visit self-agreement, train single-run versus consensus targets on
the same positions, and require a held-out regret improvement. **v4.4** is the representation
experiment: compare the 242-feature baseline, the local-interaction MLP and the amortised spatial
policy on the same consensus-labelled split. Only the winning policy receives an equal-compute root
prior tournament. A value head and iterative self-play come after that gate. The eventual `v4`
name should require a reproduced playing-strength win over `v3.2-pro-max`, not merely higher offline
imitation accuracy.

### 9.8 v4.3 local-interaction result

`MEASURED` The first v4.3 representation experiment exported 256 new v3.2-pro-max games in eight
32-game shards: 207,300 rows / 18,609 root groups. A–G supplied 181,628 identical training rows /
16,298 groups to three deterministic arms; the entire 25,672-row H shard remained untouched. The
arms used the original 242 features, those features plus four home-relative coordinates (246), and
the full 256-feature contract adding local per-opponent contacts. Network shape, seed, visit target,
loss and training groups were otherwise identical.

On H, the 242-input control reached 61.94% pair accuracy and 27.19% top-1. Home-relative coordinates
alone reached 62.10% / 28.88%. The full local-interaction model reached **63.02% pair accuracy and
29.45% top-1**: gains of 1.09 and 2.26 percentage points over the exact control. Its mean policy-mass
regret fell from 0.1684 to 0.1586 (−5.8%), and searched-value regret fell from 1.148 to 1.077 (−6.1%).
Pair accuracy improved in opening, midgame and endgame; top-1 improved overall primarily through the
midgame. This confirms that the old representation discarded useful action/opponent interaction
information. Coordinate aliasing was real but accounted for only part of the gain.

The result did not yet transfer into a material playing-strength upgrade. At an approximately 8%
lower measured wall-clock cost, the 256-feature root prior scored **+0.20 [−1.20, 1.56]** against
v3.2-pro over 40 seeds / 160 seat-rotated games, with 33.8% first place. The point estimate is
positive but below the +0.5 advancement rule and highly unresolved, so no larger match is warranted.
The correct conclusion is not that representation failed: it improved every offline deployment
metric on a strict holdout. Rather, single-search imitation and/or the way the root prior is blended
still limits conversion into strength. The next controlled experiment therefore holds the
256-feature representation fixed and compares one-search visits with three-search consensus
distributions and confidence weighting.

`MEASURED` That target experiment used 96 new games / 6,950 groups, searching every root three
times independently. A–G provided 67,784 rows / 6,072 groups and H held out 9,820 rows / 878 groups
(859 with at least two candidates). On H, the model trained on run-zero visits scored 62.50% pair
accuracy / 31.08% top-1 against the consensus distribution. Direct unweighted consensus training
scored **63.11% / 31.78%**, gains of 0.62 and 0.70 points; policy-mass regret changed only from
0.14266 to 0.14231 and searched-value regret from 0.7799 to 0.7743. Weighting roots by top-choice
agreement scored 62.80% / 31.32% and worsened overall policy-mass regret. It improved opening
top-1 and regret materially but gave the gain back in midgame.

The target was cleaner—run zero and consensus chose the same move only about 64% of the time—but
cleaner labels alone did not close the deployment gap at this data volume. No online match is
warranted for a sub-one-point offline top-1 gain with essentially flat regret. Keep consensus
export as the preferred labelling mechanism for the next representation experiment, but move the
main effort to an explicit action-mask spatial encoder rather than further confidence-weight tuning.

`MEASURED` The v4.4 spatial diagnostic then exported 64 games with both three-search consensus
labels and explicit candidate masks. A–G contained 45,298 rows / 4,064 roots; H held out 6,501 rows /
580 roots. On H, the 256-feature MLP's pair-selected checkpoint scored 63.53% pair accuracy, 30.27%
top-1 and 0.1320 policy-mass regret. A generic child-board/action convolution scored 63.13%, 33.27%
and 0.1306: lower pair ordering but a three-point improvement on the move actually chosen.

The architecture matching eventual deployment performed best. It convolves the shared parent board
once, pools the resulting cell embeddings under each candidate footprint, and combines that local
vector with the 256 engineered inputs. Its pair-selected checkpoint scored **63.24% pair accuracy,
33.45% top-1 and 0.1268 regret**. A nearby checkpoint selected for top-1 reached 33.98% / 0.1256
regret at 62.84% pair accuracy. It overfit after only a few epochs, and repeat initialisations moved
the scalar baseline by several tenths, so this is a direction result rather than a deployable model.

The important finding is metric-specific: an explicit action mask materially improves top-choice
accuracy and regret while slightly worsening lower-list pair accuracy. That is precisely why v4.3
changed the deployment gate. Advance the shared-state/pooled-action design to a larger consensus
corpus with early stopping on held-out regret; do not online-test or port this diagnostic network
yet. If the top-1/regret gain reproduces, implement its amortised root inference and only then run an
equal-compute match.

### 9.9 v4.5 scaled spatial result: representation succeeds, cloning does not

`MEASURED` The scaled experiment corrected two optimistic details in the v4.4 diagnostic before
using it for a decision. First, v4.4 selected checkpoints while repeatedly reading H; v4.5 instead
used A–F for fitting, G exclusively for regret-based early stopping and H exactly once after the
selected weights were restored. Second, the earlier “shared parent” preprocessing had added the
candidate footprint back into the own-stone plane. v4.5 keeps candidate cells only in the action
mask, records the mover seat and reflects every board so the mover's home corner is canonical
top-left. The convolution is therefore genuinely identical for every sibling and is computed once
per root.

The new corpus contained **256 entirely fresh games, 207,966 rows and 18,651 root groups**, with
three independent 300-iteration v3.2-pro-max searches per recorded root. A–F supplied 155,698 rows /
13,985 roots, G supplied 26,036 / 2,326 and untouched H supplied 26,232 / 2,340. Three independent
initialisation seeds compared the same 256-feature MLP with the canonical shared-board/action-mask
model. Mean H results were:

- feature MLP: 64.03% pair accuracy, 33.48% top-1, 0.12951 policy-mass regret;
- spatial pooled model: **64.48% pair accuracy, 34.83% top-1, 0.12396 regret**;
- paired spatial gain: +0.45 points pair, +1.35 points top-1 and −0.00555 regret (−4.3%).

Every seed reduced regret. Averaging the three selected spatial logits strengthened the result to
**65.26% pair accuracy, 36.53% top-1 and 0.11805 regret**: +3.05 top-1 points and 8.8% lower regret
than the mean scalar baseline. G independently selected temperature 1.0 by cross-entropy. Phase
results reproduced the spatial advantage most clearly in opening and midgame; endgame was less
consistent. Thus the original representation claim survives a four-times-larger, leak-free test.

`IMPLEMENTED` The amortised network was ported to the TypeScript engine: three SAME-padded 3×3
convolutions encode a canonical four-channel parent once; each placement mean-pools embeddings under
its action mask and combines them with the 256 engineered features. A real midgame parity fixture
matched Keras scores within **2.63e-7** maximum absolute error. A 30-position interleaved benchmark
measured v3.2-pro at 367.2 ms/move, the single spatial member at 372.0 ms (+1.3%) and the three-member
ensemble at 346.5 ms (−5.6%) after their iteration scales were compute-matched at 4.46 and 4.19.

The offline gain still did **not** become playing strength when used only as a PUCT prior:

- single member: **−0.27 [−1.43, 0.93]**, 40 seeds / 160 games;
- three-member ensemble: **−0.02 [−1.22, 1.09]**, 40 seeds / 160 games.

This localises the conversion failure: after roughly 1,250 root iterations, the search washes out a
better imitation prior. Treating the learned distribution as explicit final-readout evidence looked
promising at 128 total pseudo-visits (+2.09 [−0.01, 4.15] over a 16-seed triage), but a predeclared
fresh 40-seed confirmation scored **−0.02 [−0.93, 0.96]**. Heavier settings produced +0.37 at 256 and
−0.03 at 512. Restricting the policy to opening/midgame produced −0.13 without pseudo-visits and
+0.66 with 128, both over 16 seeds and both unresolved. The apparent 128 gain was selection noise,
not a version.

`CONCLUSION` Do not promote v4.5. This branch demonstrates a real representation advance and an
exact, affordable deployment, but it also demonstrates the ceiling of **policy cloning**: learning
to reproduce a stronger instance of the same search does not reliably improve that search. Further
feature engineering, larger visit-imitation corpora, prior temperatures or readout weights are low
priority.

The next v4 experiment must change the supervision from “what did this search visit?” to “what was
the counterfactual score consequence of this action?” A concrete v4.6 design is:

1. Sample roots from multiple opponents and policies, not only the teacher's on-policy trajectory.
2. Form a wider action set before the current hand-written funnel: heuristic leaders, spatially and
   piece-diverse moves, and hard/random negatives. The present top-12 post-funnel dataset cannot
   teach the model to rescue a move the funnel deleted.
3. Evaluate each action with common-random-number continuations or a materially deeper independent
   search, storing four-seat outcome margins, uncertainty and action regret. Visits may remain an
   auxiliary target, not the promotion target.
4. Train an action-conditioned `Q(s,a)`/advantage head plus a separate `V(s)` head. Use uncertainty
   to allocate additional labels near close decisions and to abstain back to search out of
   distribution.
5. Deploy the model where it can change the answer: widen/reorder the pre-search action funnel,
   initialise sequential-halving elimination, or supply a counterfactual value term. Do not add a
   fourth way to blend the same cloned prior.

That is the architectural step the evidence now supports: **policy improvement from counterfactual
outcomes, not further policy imitation**. The `v4` name remains reserved for a reproduced online win.

---

## References

Cazenave, T. (2008). Multi-player Go. *Computers and Games*.
Chaslot, G., Winands, M. H. M., & van den Herik, H. J. (2008). Parallel Monte-Carlo tree search.
Childs, B. E., Brodeur, J. H., & Kocsis, L. (2008). Transpositions and move groups in MCTS. *IEEE CIG*.
Enzenberger, M., & Müller, M. (2010). A lock-free multithreaded Monte-Carlo tree search algorithm.
Hopcroft, J., & Tarjan, R. (1973). Efficient algorithms for graph manipulation. *CACM*.
Knuth, D. E. (2000). Dancing Links.
Lorentz, R. (2016). Using evaluation functions in Monte-Carlo tree search. *TCS*. *(Premise does not
hold in Blokus — see §2.2.)*
Luckhardt, C., & Irani, K. (1986). An algorithmic solution of n-person games. *AAAI*.
Nijssen, J. A. M., & Winands, M. H. M. (2011, 2013). Enhancements for multi-player MCTS; Search
policies in multi-player games. *ICGA Journal* 36(1).
Petosa, N., & Balch, T. (2019). Multiplayer AlphaZero. *arXiv:1910.13012*.
Saffidine, A., Cazenave, T., & Méhat, J. (2012). UCD: Upper Confidence bound for rooted DAGs.
Schadd, M. P. D., & Winands, M. H. M. (2011). Best Reply Search. *IEEE TCIAIG* 3(1).
Shibahara, K., & Kotani, Y. (2008). Combining final score with winning percentage by sigmoid function.
*IEEE CIG*. *(Test domain Blokus Duo — two players; see §1 on aggregation.)*
Sturtevant, N. R., & Korf, R. E. (2000). On pruning techniques for multi-player games. *AAAI*.
Sturtevant, N. R. (2008). An analysis of UCT in multi-player games.
