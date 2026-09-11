# Designing a Strong Automated Agent for Four-Player Blokus

## A Research Synthesis on Search Algorithms, Spatial Heuristics, Phase Strategy, and Seat Asymmetry (Revision 3)

---

## 1. The Computational Character of Blokus

Blokus is played on a 20×20 grid by four players, each holding the 21 free polyominoes of size one through five (89 squares in total). A piece may be placed only if it touches at least one same-colour piece corner-to-corner and touches no same-colour piece edge-to-edge; the first piece must cover the player's home corner. Final score is the negative of the number of squares left unplaced, with a +15 bonus for placing everything and a further +5 if the monomino is the last piece played. Three properties dominate algorithm design.

**Branching factor.** Counting all fixed orientations there are 91 one-sided polyominoes of size one to five, and each may be anchored on any of the player's open diagonal corners in several ways. Empirically the per-turn legal move count peaks in the low hundreds to well over a thousand around plies four to eight and then decays toward single digits in the endgame. Games last at most 84 plies. The tree is therefore wide-then-narrow, which argues for sampling-based search early and exact search late.

**Weak opponent coupling with heavy spatial locality.** A player's four-way interaction is not symmetric. The two adjacent-corner opponents are met early along the edges; the diagonally opposite opponent is met later in the centre. Interaction is mediated entirely through the shared board, and once regions of the board are sealed off, the game decomposes into independent packing sub-problems.

**Score, not win/loss.** Blokus is a scoring game with four independently ranked outcomes. This makes the maximand ambiguous (win, rank, margin, or raw score) and it makes multi-player game theory unavoidable: no single-agent minimax reduction is exact.

The two-player variant Blokus Duo has attracted more academic attention than the four-player game, largely through the Blokus Duo hardware design competitions run alongside the ICFPT conference (from 2013), where entrants implemented MCTS and minimax engines on FPGAs, and through Kotani's group at Tokyo University of Agriculture and Technology (Shibahara & Kotani, 2008, on blending final score with win rate inside Monte-Carlo evaluation; Sasaki & Kotani, 2009, on MCTS for Blokus Duo). For the four-player game the most rigorous published comparisons are those of Nijssen and Winands (2011, 2013), who used Blokus alongside Chinese Checkers, Focus, and Rolit as a test domain for multi-player MCTS and minimax variants. What follows draws on those results, on the broader multi-player search literature (Luckhardt & Irani, 1986; Sturtevant & Korf, 2000; Sturtevant, 2003; Zuckerman, Felner & Kraus, 2009; Schadd & Winands, 2011), and on polyomino packing and exact-cover theory (Knuth, 2000).

---

## 2. Algorithm Selection

### 2.1 Candidates

**Max^n (Luckhardt & Irani, 1986).** Each node holds a vector of four utilities; the player to move chooses the child maximising their own component. It is the theoretically correct backup for a non-cooperative n-player game under the assumption that opponents are self-interested and tie-breaking is fixed, but it admits only shallow pruning (Sturtevant & Korf, 2000; Sturtevant, 2003, on last-branch and speculative pruning), so effective depth is limited to three or four plies in a game with hundreds of moves per ply. It also assumes opponents ignore you, which is false in a game where blocking is routine.

**Paranoid (Sturtevant & Korf, 2000).** Collapses the game to two players (me versus a coalition of the other three), enabling full alpha-beta pruning and therefore roughly twice the depth of max^n. The assumption is pessimistic: in real Blokus the three opponents also fight each other, so paranoid search systematically undervalues moves that rely on opponents being distracted. Nijssen and Winands found paranoid stronger than max^n at short time controls in their multi-player suite, but the advantage erodes as the coalition assumption diverges from actual play.

**Best Reply Search (Schadd & Winands, 2011).** Between the root player's moves, only the single most damaging opponent move (across all opponents) is considered, so depth is expanded further at the cost of an unrealistic move sequence in which opponents may skip turns. In Blokus, BRS's illegal-sequence artefact is mild (skipping a turn does not violate the geometry) and it does capture the crucial idea that at any moment usually one opponent is the relevant threat.

**Multi-player MCTS.** UCT with a score vector backed up at every node and each player selecting on their own component (Cazenave, 2008; Sturtevant, 2008; Nijssen & Winands, 2011). It needs no evaluation function to be sound, degrades gracefully with branching factor because it samples rather than enumerates, and can embed max^n, paranoid, or BRS as the *selection policy* while keeping Monte-Carlo playouts (Nijssen & Winands, 2013). Enhancements that proved important in that work include progressive history (a history-heuristic bias on selection), ε-greedy playouts driven by cheap domain knowledge, and playout search (shallow searches inside playouts). Shibahara and Kotani (2008) additionally showed that backing up a sigmoid of the final score margin, rather than a pure win indicator, sharpens Monte-Carlo estimates in a scoring game.

**Reinforcement learning (AlphaZero-style self-play).** A residual network over stacked colour planes predicting a policy over piece placements and a value target, trained by self-play with MCTS as the policy improvement operator. This is the strongest option in principle and has been demonstrated for Blokus Duo in student and hobbyist projects; Petosa and Balch (2019) showed the multiplayer extension (a value vector, one component per player) works on small n-player games. The four-player version raises a real stability question: as the learner's policy changes, so does the environment formed by its three copies, and naive self-play can cycle rather than converge. It is worth being precise about which remedies apply. Counterfactual regret minimisation is designed for imperfect-information games and Nash-Q does not scale to this state space; neither is the right tool for a perfect-information, deterministic, four-player scoring game. What does apply is opponent diversity: maintain a league of past checkpoints and heuristic agents, sample opponents from it (fictitious-play or AlphaStar-style population training), rotate the learner through all four seats, and gate promotion of a new checkpoint on its performance against the whole league rather than only its immediate predecessor. Because Blokus is not zero-sum across four players, the value target should be two-headed: a four-component expected-score vector (dense, useful for search guidance and shaping) and a categorical distribution over final rank (1st–4th), which is what the agent actually optimises when the rank objective is active (§5).

### 2.2 Recommendation

The core engine should be a **multi-player MCTS with a max^n-vector backup, heavy heuristic move ordering, and score-based (not win-based) backup**, for four reasons.

First, the branching factor. Enumerative minimax at width 500 cannot see past a single round of play (four plies) in tournament time. MCTS with progressive widening focuses simulations on the top-k heuristically ranked moves and grows the tree asymmetrically toward good lines, so depth in the principal variation routinely reaches several rounds.

Second, correctness of the game model. The max^n vector backup is the least wrong assumption about three independent opponents; paranoid and BRS can be enabled inside MCTS as *alternative selection policies* for opponent nodes when the agent is behind and needs to model a coalition (see §5).

Third, the evaluation problem. Random playouts in Blokus are informative because the scoring rule is simple, and they can be truncated after a fixed number of plies with a heuristic evaluation (early playout termination, in the manner of Lorentz's work on Amazons and Breakthrough), which is far cheaper than a well-tuned static evaluator deep enough for minimax.

Fourth, extensibility. The same tree accepts a learned policy prior and value head when self-play data are available, converting the engine into an AlphaZero-style system without re-architecting.

Minimax methods still have a place: **exact search in the endgame** (§4.3), where widths are small and the sub-problems are independent.

---

## 3. Heuristic Evaluation Functions

Notation: for player *i* let *S_i* be squares placed, *R_i* the multiset of remaining pieces, *C_i* the set of open corner cells (empty cells diagonally adjacent to a piece of *i* and not edge-adjacent to one), and *A_i* the set of legal placements.

### 3.1 Territory and Mobility

**Corner count |C_i|.** The cheapest and most predictive single feature; a corner is a "liberty" in Go terms. Weight it more heavily early. Distinct corners in *distinct regions* are more valuable than clustered corners, so use a diminishing-returns transform such as Σ over regions of sqrt(corners in region).

**Legal move count |A_i|.** More expensive but captures piece-shape compatibility. With bitboards it costs one AND per (piece orientation, anchor) pair.

**Reachable territory.** Compute, for each player, a multi-source shortest-path map *d_i(c)* from that player's open corners over empty cells, where a step is allowed diagonally through empty cells and orthogonally through empty cells that are not edge-adjacent to that player's own colour (a cheap approximation to piece geometry). Then define the Voronoi territory

  T_i = { c empty : d_i(c) < d_j(c) for all j ≠ i, with ties awarded by turn order to the player who moves first }.

|T_i| estimates the squares *i* can still expect to place if uncontested; the tie-break rule encodes the tempo advantage of moving earlier. A sharper but costlier variant weights each cell by the largest piece in *R_i* that fits there.

**Frontier pressure.** For each corner *c* in *C_i*, count how many opponent corners lie within move-distance two; corners under pressure are discounted because they are likely to be occupied before the agent's next turn (there are three opposing plies between the agent's turns).

**Chokepoints as articulation points.** Build the empty-cell graph *G_E* with 4-connectivity (a piece's cells are orthogonally connected, so a diagonal-only gap is impassable for a piece, though a player who already owns a corner on the far side can still play there). Run Tarjan's linear-time algorithm to find articulation points and biconnected components; recompute incrementally only for the region touched by the last move. Occupying an articulation point splits a region, which is the single most consequential spatial event in the game, but the sign of its value depends on who ends up on which side. Score a candidate split as

  Δsplit_i(m) = Σ_regions r produced by m [ own_share_i(r) − Σ_{j≠i} λ_j · own_share_j(r) ] − (value of the unsplit region to i),

where own_share is the region's cell count weighted by which players still hold corners inside it (a region with only *i*'s corners is worth its full packable size to *i*; a region with no corners of *i* is worth zero and is a pure loss if it was previously contested). This term is deliberately non-linear: it is large and positive when the cut seals territory in which only the agent has corners, large and negative when it seals the agent out, and near zero otherwise. Adding it to the move-ordering score is what makes the search look at cut moves at all when they otherwise place a small piece.

### 3.2 Aggression versus Preservation

Model the value of a candidate move *m* for player *i* as

  V_i(m) = Δ own(m) + Σ_{j≠i} λ_j · Δ harm_j(m)

where Δ own is the change in own expected territory and corners, Δ harm_j is the reduction in opponent *j*'s expected territory, and λ_j are aggression coefficients. Three results follow from the game structure.

**The free-rider effect.** With four players a pure blocking move against *j* costs *i* a tempo and a piece while benefiting *j*'s other two rivals as much as *i*. Under a score-margin objective the block is worth it only if Δ own(m) is nearly as good as the best non-blocking alternative; under a rank objective, blocking the current *leader* is worth more because rank is zero-sum among the top places. This is why λ_j should be a function of *j*'s current standing, not a constant.

**Dual-purpose moves dominate.** The empirically strongest Blokus moves both extend own reach and occupy a cell an opponent needed. In the search this is captured automatically by MCTS; in the ordering heuristic it is captured by scoring moves on Δ own + λ Δ harm rather than either alone.

**Packing efficiency as a first-class term.** Waste is created by leaving pockets no remaining piece can fill. Penalise the number of empty cells that are unreachable by any piece in *R_i* (compute by testing whether any orientation of the smallest remaining pieces fits at each cell in own territory). Placing large pieces first minimises later waste because small pieces are more likely to fit residual holes; a per-move bonus proportional to piece size, decaying over the game, encodes this.

A workable composite evaluation for playout truncation is

  E_i = a·S_i + b·f(C_i) + c·|T_i| − d·waste_i − Σ_{j≠i} λ_j(e·|T_j| + g·f(C_j))

with a, b, c, d, e, g tuned by self-play or CMA-ES and λ_j set per §5.

---

## 4. Phase-Specific Strategy

Phase can be detected from the ply number, the fraction of the board that is still contestable (|∪ T_i| / empty cells), and the number of disconnected empty regions.

### 4.1 Opening (own moves 1–5)

The centre is the scarce resource. From the corner, the shortest diagonal path to the centre is about ten cells; the pieces with the longest diagonal reach per square (the F, W, N, Z and Y pentominoes and the V-shaped pieces) cover that distance in three to four moves. The objective weights should be almost entirely on corner count and centre-reachability, measured as Σ over open corners of a decreasing function of Manhattan distance to the centre. Play pentominoes exclusively; keep the I5 in reserve unless it opens a lane. Aim to fan into two or three separate corridors so that a single opponent block cannot cut all lines. Blocking is rarely justified in this phase because opponents' territories are far away and a block wastes tempo. A small opening book generated offline by long MCTS runs from the empty board is cheap and effective, since the position space at ply four is small.

### 4.2 Mid-game (own moves 6–15)

This is where opponent interaction peaks. Objectives shift toward territory delineation: identify chokepoints (single cells whose occupation would separate regions) and prioritise moves that seal off territory in the agent's favour, especially along the borders with the two adjacent-corner opponents. Maintain corners in at least two independent regions. Aggression coefficients λ_j should be highest here, and highest against the opponent whose Voronoi frontier with the agent is longest, because contested cells there are the ones actually at stake. Piece-size ordering remains important, but shape now matters more than size: a T4 that plugs a chokepoint can outrank a pentomino that merely extends.

### 4.3 Endgame (own moves 16–21, and whenever the empty region containing the agent's corners is sealed)

Once the agent's remaining reachable area is a set of regions no opponent can enter, the problem becomes a deterministic **maximum-weight packing under the corner rule**: choose a subset of remaining pieces and placements to maximise squares placed, plus the 15/20 bonuses. Independent regions are solved independently and summed. Two formulations are useful; the first for speed inside the search loop, the second for rigour and for verifying the first.

**Formulation A — memoised depth-first search.** Search over placements with memoisation on (region bitboard, remaining-piece bitmask), pruning with the bound min(free cells, Σ remaining sizes) plus a hole-feasibility check (any empty cell no remaining piece can cover is subtracted from the bound). Sizes at this stage are small enough (typically ≤ 8 pieces, ≤ 40 cells per region) that this runs in microseconds to milliseconds and is what the MCTS leaf calls.

**Formulation B — integer linear program.** Let *P* be the remaining pieces, *O* the orientations, *K* the empty cells of the region, and *x_{p,o,c} ∈ {0,1}* indicate piece *p* in orientation *o* anchored at cell *c*. Let *A_{k,p,o,c}* be 1 if that placement covers cell *k*, and let *D* be the set of unordered placement pairs whose cells are edge-adjacent (same-colour edge contact is illegal). Let *y* be the indicator that all pieces are placed and *z* the indicator that the monomino is placed last.

  maximise Σ size(p)·x_{p,o,c} + 15·y + 5·z

  subject to Σ_{o,c} x_{p,o,c} ≤ 1 for each *p* (each piece at most once);
  Σ_{p,o,c} A_{k,p,o,c}·x_{p,o,c} ≤ 1 for each cell *k* (no overlap);
  x_a + x_b ≤ 1 for each (a,b) ∈ *D* (no own edge-adjacency);
  y ≤ Σ_{o,c} x_{p,o,c} for each *p*, and *z ≤ y*;
  and a corner-connectivity constraint: every chosen placement must be corner-adjacent to a pre-existing own piece or to another chosen placement, with the whole chosen set connected through corner adjacency to the pre-existing structure.

The connectivity constraint is the only non-trivial one, and it is what distinguishes Blokus packing from free exact cover. Because a valid final configuration must be a set of pieces with no own edge contact whose corner-adjacency graph is connected to the seed, and because any such set admits a legal placement order (breadth-first from the seed along corner-adjacency edges), it is *not* necessary to model the sequence: the ILP can be static. Connectivity is encoded either by single-commodity flow (each chosen placement receives one unit of flow from the seed along corner-adjacency arcs whose endpoints are both chosen) or, more efficiently, by lazy cut generation: solve the relaxation without connectivity, and whenever a solution contains a component disconnected from the seed, add a cut requiring at least one placement in the corner-neighbourhood of that component. The *z* variable requires only that the monomino be corner-adjacent to some other chosen piece (so it can be ordered last). Two implementation notes. First, instantiate variables from the 91 distinct fixed polyominoes with a canonical anchor cell and deduplicate any two (p,o,c) whose footprints coincide; this is hygiene rather than a large saving, since a correct generator produces each physical placement once, and it is not symmetry breaking in the operations-research sense (the pieces are all distinct, so there are no interchangeable variables to order). Second, what actually shortens branch-and-cut is a tighter relaxation: the overlap and edge-adjacency constraints define a conflict graph over placements, so replace pairwise conflicts with clique inequalities on that graph, and generate connectivity cuts lazily as described above. With that, the model is small (hundreds to a few thousand binaries) and returns proven optima in well under a second; use it offline to validate Formulation A, and online for the largest regions or when the +15 and +20 bonuses are within reach and every square matters.

**Near-sealed regions.** When a region is almost but not quite sealed, solve on the pessimistic assumption that all cells reachable by any opponent within one move are lost, giving a certified lower bound that replaces the playout as the leaf value inside MCTS; the optimistic bound (all contested cells kept) brackets it, and the gap is itself a useful measure of how much is at stake in the region.

---

## 5. Turn-Order Asymmetry

The empirical first-mover advantage in Blokus is real: with the standard clockwise seating and colour order, the first two players win measurably more often against equal opponents in self-play, because they reach the centre first and because ties in cell reachability resolve in favour of the player who moves first. The agent's parameters should depend on its seat *s* in three ways.

**Tempo tie-breaking.** In the territory map, cells at equal distance are awarded to the player who moves earlier in the round. This alone shifts several squares of estimated territory to seat 1 and away from seat 4 and should be built into T_i rather than added as a fudge factor.

**Neighbour geometry and threat timing.** Every seat has two adjacent-corner opponents (one moves immediately after you, one immediately before) and one diagonal opponent. A corner you open is exposed to three opponent plies before you can use it, so the ordering heuristic discounts new corners near the *next* player's reach most heavily (they act first), less for the player after that, and least for the previous player. Conversely, blocking the *previous* player is slightly more efficient because they must wait three plies for the position to change; blocking the *next* player is more urgent because their reply is immediate.

**Seat-conditioned objective weights.** Seat 1 should be maximally expansionist: highest weight on centre reach, lowest λ; it can afford to be blocked once. Seat 4 has the least central access and the most information; it should weight territory security and packing efficiency higher, prefer moves that seal a defensible region early, and raise λ against the opponent that has already committed toward its corner (typically visible after three plies). Seats 2 and 3 sit between, with seat 3 typically the most exposed because both its neighbours have moved before it can respond twice. A convenient parameterisation is a per-seat vector (θ_centre, θ_corners, θ_territory, θ_waste, λ_next, λ_prev, λ_diag) tuned by round-robin self-play in which the agent is rotated through all seats; the tuned differences are usually modest but consistent.

**Objective choice.** Because rank and margin can conflict, the agent should optimise a per-seat blend, favouring rank (win probability) when trailing badly, since only outcomes among the leaders matter, and favouring margin when leading, to avoid speculative blocks. This is where the paranoid or BRS selection policy for opponent nodes is useful: when the agent is the leader, opponents are more likely to coalesce against it, and a paranoid opponent model is more accurate; when the agent is trailing, max^n is more accurate.

---

## 6. Proposed Architecture

**Layer 0 — Representation.** Four 400-bit bitboards (one per colour) plus derived masks: occupied, per-colour edge-adjacency, per-colour corner cells. Precompute for every (piece, orientation, anchor offset) a 400-bit mask; move generation is then a loop over open corners and compatible orientation masks with two ANDs (no overlap with occupied, no overlap with own edge-adjacency). Zobrist hashing keyed on (cell, colour) for a transposition table. Transpositions are unusually common in Blokus, because permuting the order of a player's own placements reaches the same position, and the game is monotone (cells only fill), so the search graph is a DAG with no cycles. It is therefore safe and worthwhile to make the tree transposition-aware, sharing node statistics across parents, with the caveat that UCT on a DAG must decide whether the parent visit count in the exploration term is the edge's or the shared node's (Childs, Brodeur & Kocsis, 2008; Saffidine, Cazenave & Méhat, 2012).

**Layer 1 — Fast evaluation.** Incremental maintenance of corner counts, per-player Voronoi territory via BFS on the empty-cell graph, waste estimate, and the composite E_i. This feeds both move ordering and playout truncation.

**Layer 2 — Search controller.** Detect phase and seat; load the corresponding weight vector; choose engine:

- Opening: consult the opening book; otherwise MCTS.
- Mid-game: multi-player MCTS with score-vector backup (sigmoid of margin, per Shibahara & Kotani), progressive widening over heuristically ranked moves, progressive history bias, ε-greedy playouts (ε ≈ 0.1–0.2 heuristic vs. random) truncated at ~12 plies with E_i, RAVE optional. Opponent-node selection policy switched between max^n (default), paranoid (when leading), and BRS (when very short on time).
- Endgame: when the agent's regions are sealed, call the exact packing solver directly; when nearly sealed, use its lower bound as the leaf value inside MCTS.
- Sealed-region hand-off inside the tree: at expansion, if the child state contains any region no opponent can enter (for any player, not only the agent), do not run a playout for that region; call the exact solver, cache the result by (region bitboard, remaining-piece mask), and back up its proven value as that player's component of the score vector. This prevents the horizon effect in which the search undervalues a move that seals highly packable territory because random playouts pack it badly. Once a player is entirely sealed off, drop them from playouts altogether, since nothing they do can affect anyone else. The solver call must be memoised and time-capped, falling back to the packing bounds, so a pathological region cannot stall a leaf.

**Concurrency.** Tournament time controls require tree parallelism: many threads traverse the same tree with virtual loss (Chaslot, Winands & van den Herik, 2008), which for a score-vector backup means adding, at each traversed node, a temporary visit carrying a pessimistic value for the player to move there, removed when the true result is backed up. Node statistics are updated with lock-free atomics in the manner of Enzenberger and Müller (2010), and the transposition table is a lock-free hash map with compare-and-swap replacement. Playouts and exact-solver calls are embarrassingly parallel; the solver cache is shared and lock-free as well. Root parallelism (independent trees merged at the end) is a simpler fallback that scales worse but is useful for cluster-level self-play generation.

**Layer 3 — Learning (optional but recommended).** Train a policy-value network on self-play games generated by Layer 2, with two value heads (four-player expected-score vector and rank distribution) and a policy head over the (piece, orientation, anchor) move space; use it as the prior in progressive widening and as the leaf evaluator, and tune the hand-crafted weight vectors of Layer 1 against it. Generate data against a league of checkpoints and heuristic agents rather than pure current-policy self-play, rotate seats during data generation so seat asymmetry is learned rather than assumed, and promote checkpoints only on league-wide performance.

**Layer 4 — Evaluation and regression harness (§7).**

Pseudocode for the controller:

```
choose_move(state, seat):
    phase   = detect_phase(state)
    weights = W[phase][seat]
    if phase == OPENING and book.has(state): return book.get(state)
    if regions_sealed(state, seat):        return exact_pack(state, seat)
    tree = MCTS(root=state, backup=score_vector_sigmoid,
                prior=policy_net or heuristic_rank(weights),
                widening=progressive, playout=eps_greedy(weights, cutoff=12),
                leaf_value=exact_pack_if_sealed else playout,   # per-player, cached
                opp_policy=(paranoid if leading(state,seat) else maxn),
                threads=N, virtual_loss=True, transpositions=DAG)
    run until time budget (see time management, §6.1); return argmax_visits(tree.root)
```

### 6.1 Time management

Nobody wins Blokus in the last three moves, but engines lose it by spending their clock there. Allocate the budget by expected decision value: the opening is book-driven and cheap; plies roughly 6 to 14 for the agent (moves 2 through 4 of the mid-game onward) carry the largest branching factor and the largest score swings and should receive the bulk of the clock; the endgame is exact and near-free. A simple rule is to allocate time proportional to a smoothed estimate of root-move value spread (the gap between the best and second-best root children after a short probe), with early termination when the best move's visit lead cannot be overturned in the remaining budget.

**Design rationale in one paragraph.** MCTS handles the width, the max^n vector handles the multi-player semantics, the heuristics handle the spatial structure that random sampling misses, the exact solver handles the endgame where sampling wastes effort, and seat- and phase-conditioned weight vectors handle the two asymmetries — temporal (phase) and positional (seat) — that distinguish a strong Blokus player from a merely competent one.

---

## 7. Evaluation and Testing Framework

Search engines fail silently: a weak move on ply 12 becomes a loss on ply 70 with nothing in between to point at. The evaluation harness therefore needs three tiers, ordered from cheapest to most authoritative.

**Tier 1 — Unit and behavioural regression tests.** Property tests on the move generator (every generated move is legal; every legal move is generated, checked against a slow reference implementation on random positions), incremental-evaluation consistency (incremental corner/territory updates equal a from-scratch recomputation after every move), and exact-solver agreement (Formulation A equals Formulation B on a bank of sealed regions). On top of these, a curated suite of static positions with tags such as "chokepoint available", "seal-out threat", "leader must be blocked", "reserve monomino", each with a human-approved set of acceptable moves; the test asserts the engine's chosen move is in the set at a fixed node budget. This suite is what turns a qualitative complaint into a reproducible failing test.

**Tier 2 — Oracle-labelled blunder analysis.** Take a long-time-control run of the same engine (or the ILP where applicable) as an oracle and replay each logged game, recording at each of the agent's moves the oracle's estimated score-vector loss relative to the oracle's best move. This is the Blokus analogue of centipawn loss, and it localises errors to plies. Aggregating loss by phase, by seat, and by heuristic feature active at the time (was an articulation point available? was a block chosen?) gives directly actionable signal for tuning the weight vectors *W[phase][seat]* and the aggression coefficients λ. It is far more precise than win rate.

**Tier 3 — Tournament statistics.** Round-robin and league play against fixed baselines (greedy largest-piece, one-round max^n, previous checkpoints), with every configuration rotated through all four seats, scored with a rating system that handles four-way outcomes (TrueSkill or a Plackett–Luce model), and with confidence intervals reported. Seat rotation is essential: an unrotated four-player result confounds engine strength with the first-mover advantage described in §5.

A note on LLM-as-a-judge for game logs, since it is a natural suggestion for qualitative failure analysis. It can be useful for triaging Tier 2 output into human-readable categories, but two cautions apply. First, current language models are weak at reasoning directly over a 20×20 spatial state, so the judge should never see raw board strings. Serialise each game as a chronological sequence of engine-computed topological events, for example: "Turn 14: Blue plays W-pentomino on an articulation point of the central region, splitting it into regions of 22 and 14 cells; Blue holds 3 corners in the 22-cell region, Red 1, no one in the 14-cell region; oracle loss for this move 0.4 squares; best alternative was a non-splitting extension." Feeding the outputs of the Voronoi BFS, Tarjan's algorithm, and the oracle directly into the text confines the judge to strategic classification of events it did not have to perceive, which is the task it is competent at. Second, the judge must be validated against a human-labelled subset before its verdicts are used for tuning; automatic judges can be confidently wrong in ways that diverge systematically from human review, and an unvalidated judge would simply relocate the tuning error rather than remove it.

**On dynamic playout randomness.** A tempting refinement is to vary the ε of the playout policy by node uncertainty. Note that ε governs the *simulation* policy while uncertainty lives in the *tree*, and mixing the two tends to make evaluation noisier exactly where the tree needs stability. The established places to spend a variance signal are in selection (UCB1-Tuned, or a variance term in the exploration constant) and in early playout termination (terminate earlier at low-variance leaves, later at high-variance ones). Playout ε is best tuned once per phase and left fixed.

## 8. What Remains Empirical

The design above is internally consistent, but every quantity that will determine playing strength is still an untested hypothesis: whether Voronoi territory and articulation-point features remain predictive once opponents adapt to them, how much seat-conditioned tuning buys over a single weight vector, whether the sigmoid-margin backup or the rank head is the better selection signal, and how the engine behaves under real time controls. The correct next step is not further specification. It is a bitboard move generator with a slow reference implementation beside it, so that the Tier 1 tests exist, followed by measurement.

## References and Known Computational Approaches

Cazenave, T. (2008). Multi-player Go. *Computers and Games*.  
Chaslot, G., Winands, M. H. M., & van den Herik, H. J. (2008). Parallel Monte-Carlo tree search. *Computers and Games*.  
Childs, B. E., Brodeur, J. H., & Kocsis, L. (2008). Transpositions and move groups in Monte Carlo tree search. *IEEE CIG*.  
Enzenberger, M., & Müller, M. (2010). A lock-free multithreaded Monte-Carlo tree search algorithm. *Advances in Computer Games 12*.  
Vinyals, O., et al. (2019). Grandmaster level in StarCraft II using multi-agent reinforcement learning (league training). *Nature*.  
Herbrich, R., Minka, T., & Graepel, T. (2007). TrueSkill: a Bayesian skill rating system. *NIPS*.  
Hopcroft, J., & Tarjan, R. (1973). Efficient algorithms for graph manipulation (articulation points). *CACM*.  
Knuth, D. E. (2000). Dancing Links. *Millennial Perspectives in Computer Science*.  
Luckhardt, C., & Irani, K. (1986). An algorithmic solution of n-person games. *AAAI*.  
Petosa, N., & Balch, T. (2019). Multiplayer AlphaZero. *arXiv:1910.13012*.  
Nijssen, J. A. M., & Winands, M. H. M. (2011). Enhancements for multi-player Monte-Carlo tree search. *Computers and Games (CG 2010)*.  
Nijssen, J. A. M., & Winands, M. H. M. (2012). Playout search for Monte-Carlo tree search in multi-player games. *Advances in Computer Games 13*.  
Nijssen, J. A. M., & Winands, M. H. M. (2013). Search policies in multi-player games. *ICGA Journal*, 36(1). (Includes four-player Blokus as a test domain.)  
Saffidine, A., Cazenave, T., & Méhat, J. (2012). UCD: Upper Confidence bound for rooted Directed acyclic graphs. *Knowledge-Based Systems*.  
Sasaki, K., & Kotani, Y. (2009). Monte-Carlo tree search in the game of Blokus Duo. *14th Game Programming Workshop*.  
Schadd, M. P. D., & Winands, M. H. M. (2011). Best Reply Search for multiplayer games. *IEEE TCIAIG*, 3(1).  
Shibahara, K., & Kotani, Y. (2008). Combining final score with winning percentage by sigmoid function in Monte-Carlo simulations. *IEEE CIG*. (Test domain: Blokus Duo.)  
Sturtevant, N. R., & Korf, R. E. (2000). On pruning techniques for multi-player games. *AAAI*.  
Sturtevant, N. R. (2003). A comparison of algorithms for multi-player games. *Computers and Games*; and Last-branch and speculative pruning algorithms for max^n. *IJCAI*.  
Sturtevant, N. R. (2008). An analysis of UCT in multi-player games. *Computers and Games*.  
Zuckerman, I., Felner, A., & Kraus, S. (2009). Mixing search strategies for multi-player games (MP-Mix). *IJCAI*.  
ICFPT Blokus Duo Design Competition (2013 onward): FPGA implementations of MCTS and minimax Blokus Duo engines, including shared-memory parallel MCTS solvers.  
Lorentz, R. (2016). Using evaluation functions in Monte-Carlo tree search (early playout termination). *Theoretical Computer Science*.
