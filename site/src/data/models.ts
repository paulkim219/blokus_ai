export const PLAY_BLOKUS_URL = 'https://blokee.mattle.online/lobby/rooms';

export type ModelId =
  | 'hanni-1'
  | 'hanni-2-lite'
  | 'hanni-2-pro'
  | 'hanni-3-1-nano'
  | 'hanni-3-1-lite'
  | 'hanni-3-1'
  | 'hanni-3-1-pro'
  | 'hanni-3-1-pro-max'
  | 'hanni-3-2-lite'
  | 'hanni-3-2'
  | 'hanni-3-2-pro'
  | 'hanni-3-2-pro-max'
  | 'hanni-3-5-lite'
  | 'hanni-3-5'
  | 'hanni-3-5-pro'
  | 'hanni-3-6-pro-max'
  | 'hanni-3-7-lite'
  | 'hanni-3-7'
  | 'hanni-3-7-pro'
  | 'hanni-3-7-pro-max'
  | 'hanni-4-1-lite'
  | 'hanni-4-1'
  | 'hanni-4-1-pro'
  | 'hanni-4-1-pro-max'
  | 'hanni-4-1-ultra'
  | 'hanni-4';

export type ComparatorId = ModelId | 'greedy';

export type GenerationId = '1' | '2' | '3.1' | '3.2' | '3.5' | '3.6' | '3.7' | '4.1' | '4';

export type ModelStatus = 'baseline' | 'shipping' | 'champion' | 'coming-soon';

export type EngineKind = 'legacy' | 'bitboard' | 'learned';

export interface ModelRecord {
  id: ModelId;
  algoId: string;
  generation: GenerationId;
  displayName: string;
  shortName: string;
  status: ModelStatus;
  kicker: string;
  lede: string;
  created: string;
  changed: string;
  engine: EngineKind;
  costMsPerMove: number | null;
  iterationScale?: number;
  comparators: ComparatorId[];
  related: ModelId[];
}

export const MODELS: Record<ModelId, ModelRecord> = {
  'hanni-1': {
    id: 'hanni-1',
    algoId: 'v1',
    generation: '1',
    displayName: 'Hanni 1',
    shortName: '1',
    status: 'baseline',
    kicker: 'Hanni 1 · Baseline',
    lede: 'The first engine that clearly beat one-ply greedy search. Later generations still quote their results against it.',
    created:
      'Hanni 1 is a Monte-Carlo tree search on an object-board representation. It uses cheap truncated rollouts, a hand-set heuristic over placed squares, corners, mobility, and blocking, and picks the final move by mean value rather than visit count.',
    changed:
      'Before Hanni 1, the floor was ranking legal moves once with a heuristic and never growing a tree. The tree, even with short rollouts, is what first separated search from that one-ply ranking.',
    engine: 'legacy',
    costMsPerMove: 364,
    comparators: ['greedy'],
    related: ['hanni-2-lite', 'hanni-2-pro'],
  },
  'hanni-2-lite': {
    id: 'hanni-2-lite',
    algoId: 'v2-lite',
    generation: '2',
    displayName: 'Hanni 2 Lite',
    shortName: '2 Lite',
    status: 'shipping',
    kicker: 'Hanni 2 · Fitted evaluation',
    lede: 'The same structure as the pre-fit generation-2 design, with weights, phase split, and seat profile learned from about 46,000 self-play games. Faster than Pro, and weaker, because its rollouts still stop early.',
    created:
      'Cross-entropy method self-play fitted the evaluation — weights, the early/late phase split, phase bonuses, the adjacent-opponent term, and a per-seat aggression/expansion profile — while the search stayed the same as the hand-designed predecessor. Rollouts remain truncated.',
    changed:
      'Fitting the evaluation, without changing the features, is most of the jump from Hanni 1. The Lite/Pro split in this generation is rollout length, not a different network or tree policy.',
    engine: 'legacy',
    costMsPerMove: 398,
    comparators: ['greedy', 'hanni-1'],
    related: ['hanni-1', 'hanni-2-pro', 'hanni-3-1-lite'],
  },
  'hanni-2-pro': {
    id: 'hanni-2-pro',
    algoId: 'v2-pro',
    generation: '2',
    displayName: 'Hanni 2 Pro',
    shortName: '2 Pro',
    status: 'shipping',
    kicker: 'Hanni 2 · Former champion',
    lede: 'Hanni 2 Lite with one field changed: rollouts play the game out instead of stopping at 24/14 plies. It remains the expensive quality bar that later, cheaper engines had to beat.',
    created:
      'Identical evaluation to Hanni 2 Lite. Generation 3 made rollout truncation an explicit parameter; sweeping it showed that cutting the simulation short was costing several points, and the same question transferred to this engine.',
    changed:
      'Playing rollouts to the end is worth about +5.9 points against Lite at equal iterations, and still about +4.9 when Lite is given the extra iterations that Pro’s longer rollouts would have spent. Iterations were cheap. Rollout quality was not.',
    engine: 'legacy',
    costMsPerMove: 878,
    comparators: ['hanni-1', 'hanni-2-lite'],
    related: ['hanni-2-lite', 'hanni-3-1-pro', 'hanni-3-2-pro'],
  },
  'hanni-3-1-nano': {
    id: 'hanni-3-1-nano',
    algoId: 'v3.1-nano',
    generation: '3.1',
    displayName: 'Hanni 3.1 Nano',
    shortName: '3.1 Nano',
    status: 'shipping',
    kicker: 'Hanni 3.1 · Truncated bitboard',
    lede: 'A bitboard engine with a fitted evaluation and a fractional territory tie-break, still truncating rollouts at 12 plies. It is now the one model here that nothing recommends: an engine-wide optimisation made full-length rollouts cheaper than truncated ones, so Hanni 3.1 Lite is both faster and five points stronger.',
    created:
      'The bitboard line started as a written design for four-player Blokus: multi-player tree search, territory features, phase and seat weights. Nano is that engine after the evaluation was fitted and the territory statistic started sharing ties, with the original 12-ply playout cutoff left in place.',
    changed:
      'Nano existed to make truncation an explicit effort level rather than a silent default, and for most of this project it was the cheapest way to play at all. That stopped being true in August 2026. The engine\u2019s hottest loop was rewritten to skip pieces already played, which pays off in the depleted-hand tail of a rollout \u2014 the part a full-length playout spends most of its time in and a 12-ply playout never reaches. Full rollouts got 39% cheaper; truncated ones only 14%. Nano now costs more than Hanni 3.1 Lite and scores five points lower, so it is kept for the record rather than recommended.',
    engine: 'bitboard',
    costMsPerMove: 46,
    comparators: ['greedy', 'hanni-1', 'hanni-2-lite'],
    related: ['hanni-3-1-lite', 'hanni-2-lite'],
  },
  'hanni-3-1-lite': {
    id: 'hanni-3-1-lite',
    algoId: 'v3.1-lite',
    generation: '3.1',
    displayName: 'Hanni 3.1 Lite',
    shortName: '3.1 Lite',
    status: 'shipping',
    kicker: 'Hanni 3.1 · Full rollouts, 300 iterations',
    lede: 'The fitted bitboard evaluation with rollouts played to the end, at 300 search iterations. It reaches parity with Hanni 2 Lite and is behind Hanni 2 Pro when both are given the same iteration count.',
    created:
      'Same evaluation as Nano — CEM-fitted weights and fractional territory ties — with the playout cutoff removed so simulations run to a real score. About 85 milliseconds per move at the 300-iteration base.',
    changed:
      'Against Hanni 2 Lite the interval spans zero: a second engine of similar strength, reached by a different route, not a promotion. At equal iterations it is behind Hanni 2 Pro, which spends an order of magnitude more time per move.',
    engine: 'bitboard',
    costMsPerMove: 45,
    comparators: ['greedy', 'hanni-2-lite', 'hanni-3-1-nano'],
    related: ['hanni-3-1-nano', 'hanni-3-1', 'hanni-2-lite'],
  },
  'hanni-3-1': {
    id: 'hanni-3-1',
    algoId: 'v3.1',
    generation: '3.1',
    displayName: 'Hanni 3.1',
    shortName: '3.1',
    status: 'shipping',
    kicker: 'Hanni 3.1 · Default compute',
    lede: 'The Lite engine given about 700 iterations instead of 300. Still behind Hanni 2 Pro on strength, and far cheaper.',
    created:
      'Nothing about the evaluation or the rollout policy changes. An iteration scale of 2.33 spends the extra budget entirely on tree depth. Wall-clock is about 190–214 milliseconds per move.',
    changed:
      'Earlier comparisons of this line against Hanni 2 Pro were iteration-matched, which gave Pro a large wall-clock advantage. Hanni 3.1 is the first named tier that starts to spend some of the compute the bitboard engine can actually afford.',
    engine: 'bitboard',
    costMsPerMove: 106,
    iterationScale: 2.33,
    comparators: ['hanni-2-lite', 'hanni-3-1-lite'],
    related: ['hanni-3-1-lite', 'hanni-3-1-pro', 'hanni-3-2'],
  },
  'hanni-3-1-pro': {
    id: 'hanni-3-1-pro',
    algoId: 'v3.1-pro',
    generation: '3.1',
    displayName: 'Hanni 3.1 Pro',
    shortName: '3.1 Pro',
    status: 'shipping',
    kicker: 'Hanni 3.1 · First bitboard champion',
    lede: 'About 1,380 iterations of the same engine. The first configuration in this line to beat Hanni 2 Pro, at roughly a quarter of the wall-clock.',
    created:
      'Again the evaluation and rollout policy are unchanged. An iteration scale of 4.59 puts the search at about 360 milliseconds per move. A width-versus-depth sweep at this budget preferred staying narrow and spending the time on more iterations.',
    changed:
      'The entire gain over Lite is compute the engine was never given in earlier bake-offs. At 300 iterations Lite costs about 85 ms while Hanni 2 Pro costs about 1,500 ms. Correct the axis, and the ordering reverses: +2.01 [1.00, 3.02] over 400 held-out games.',
    engine: 'bitboard',
    costMsPerMove: 209,
    iterationScale: 4.59,
    comparators: ['hanni-3-1', 'hanni-2-pro'],
    related: ['hanni-3-1', 'hanni-3-1-pro-max', 'hanni-3-2-pro'],
  },
  'hanni-3-1-pro-max': {
    id: 'hanni-3-1-pro-max',
    algoId: 'v3.1-pro-max',
    generation: '3.1',
    displayName: 'Hanni 3.1 Pro Max',
    shortName: '3.1 Pro Max',
    status: 'shipping',
    kicker: 'Hanni 3.1 · Max effort',
    lede: 'The same configuration at about 2,400 iterations. An effort level, not a new design.',
    created:
      'Iteration scale 8.0, rollout policy untouched. Wall-clock sits around 600–800 milliseconds per move — still well under Hanni 2 Pro.',
    changed:
      'Pro and Pro Max share every search parameter except how many iterations they buy. Naming the larger budget is a way to talk about effort, not a claim that the evaluation changed.',
    engine: 'bitboard',
    costMsPerMove: 417,
    iterationScale: 8,
    comparators: ['hanni-2-pro', 'hanni-3-1-pro'],
    related: ['hanni-3-1-pro', 'hanni-3-2-pro-max'],
  },
  'hanni-3-2-lite': {
    id: 'hanni-3-2-lite',
    algoId: 'v3.2-lite',
    generation: '3.2',
    displayName: 'Hanni 3.2 Lite',
    shortName: '3.2 Lite',
    status: 'shipping',
    kicker: 'Hanni 3.2 \u00b7 Cheapest tier',
    lede: 'The 60% uniform rollout mixture at the smallest compute tier, about 300 iterations a move. It exists on this page mainly as the honest peer for Hanni 3.5 Lite.',
    created:
      'Same single change as the rest of the 3.2 line: 60% of the moves inside a terminal rollout are drawn uniformly rather than 15%. Nothing about the tree, the evaluation, or the iteration budget differs from Hanni 3.1 Lite.',
    changed:
      'The mixture was promoted on the Pro and Pro Max tiers and carried down. Its value at this budget has not been measured on its own block, so treat it as a compute tier of a promoted change rather than as a separately evidenced result.',
    engine: 'bitboard',
    costMsPerMove: 50,
    iterationScale: 1,
    comparators: ['greedy', 'hanni-3-1-lite'],
    related: ['hanni-3-1-lite', 'hanni-3-5-lite'],
  },
  'hanni-3-2': {
    id: 'hanni-3-2',
    algoId: 'v3.2',
    generation: '3.2',
    displayName: 'Hanni 3.2',
    shortName: '3.2',
    status: 'shipping',
    kicker: 'Hanni 3.2 · Default compute',
    lede: 'The Hanni 3.1 compute tier with a different mixture inside terminal rollouts: 60% of simulated moves are uniform-random rather than 15%.',
    created:
      'A programme of extra search mechanisms — ensembles, learned priors, MAST, RAVE, variance-tuned selection — mostly failed to survive a reproduce-before-promotion rule. The change that did was the simplest: raise the uniform branch in full-length rollouts.',
    changed:
      'This is a strength release, not a speed release. It keeps the 3.1 architecture and iteration budget and changes the bias/variance mixture of the games the tree simulates.',
    engine: 'bitboard',
    costMsPerMove: 112,
    iterationScale: 2.33,
    comparators: ['hanni-2-lite', 'hanni-3-1'],
    related: ['hanni-3-1', 'hanni-3-2-pro'],
  },
  'hanni-3-2-pro': {
    id: 'hanni-3-2-pro',
    algoId: 'v3.2-pro',
    generation: '3.2',
    displayName: 'Hanni 3.2 Pro',
    shortName: '3.2 Pro',
    status: 'champion',
    kicker: 'Hanni 3.2 · Shipping champion',
    lede: 'The current champion. Same Pro-tier compute as Hanni 3.1 Pro, with 60% uniform moves in terminal rollouts.',
    created:
      'Three disjoint blocks at this tier pooled to +0.70 [0.10, 1.31] against Hanni 3.1 Pro. Fully uniform rollouts did not match that result, so the evidence favours an interior mixture rather than throwing the heuristic away.',
    changed:
      'Nothing in the evaluation, the iteration budget, or the tree policy. The simulated games are noisier and less enslaved to the same heuristic the tree already uses, and that is enough to move the champion.',
    engine: 'bitboard',
    costMsPerMove: 232,
    iterationScale: 4.59,
    comparators: ['hanni-2-pro', 'hanni-3-1-pro'],
    related: ['hanni-3-1-pro', 'hanni-3-2', 'hanni-3-2-pro-max'],
  },
  'hanni-3-2-pro-max': {
    id: 'hanni-3-2-pro-max',
    algoId: 'v3.2-pro-max',
    generation: '3.2',
    displayName: 'Hanni 3.2 Pro Max',
    shortName: '3.2 Pro Max',
    status: 'shipping',
    kicker: 'Hanni 3.2 · Max effort',
    lede: 'The Pro Max compute tier of Hanni 3.2. Two independent blocks against Hanni 3.1 Pro Max pooled to +0.88 points at the same iteration budget.',
    created:
      'The 60% uniform mixture transferred from the Pro tier to max effort: a first block of +1.38 and a replication of +0.68, pooling to +0.88 [0.25, 1.54] over 140 seeds / 560 games, with 30.9% first place.',
    changed:
      'Same interpretation as Pro: a different simulation mixture at identical tree size. The promotion rule required both independent point estimates to be positive and the pooled interval to exclude zero.',
    engine: 'bitboard',
    costMsPerMove: 451,
    iterationScale: 8,
    comparators: ['hanni-2-pro', 'hanni-3-1-pro-max'],
    related: ['hanni-3-1-pro-max', 'hanni-3-2-pro'],
  },
  'hanni-3-5-lite': {
    id: 'hanni-3-5-lite',
    algoId: 'v3.5-lite',
    generation: '3.5',
    displayName: 'Hanni 3.5 Lite',
    shortName: '3.5 Lite',
    status: 'shipping',
    kicker: 'Hanni 3.5 · Where the thinking goes',
    lede: 'The first engine here that does not think equally hard about every move. It spends its search budget on a fitted curve across a player\u2019s twenty-one placements, and beats the equivalent Hanni 3.2 tier by +1.18 points.',
    created:
      'Every engine before this one gave move 1 and move 21 exactly the same number of simulations. Hanni 3.5 redistributes that budget along a curve indexed by how many pieces a seat has already placed \u2014 cheap at the very start, heaviest through the middle game, tapering to almost nothing once the endgame packer can solve the position exactly.',
    changed:
      'The curve had been sitting unused in the codebase since the engine was first written, because it only ever reached the wall-clock path and every measurement here is budgeted in iterations. Wiring it into the iteration path and normalising it to spend the same total is the whole change.',
    engine: 'bitboard',
    costMsPerMove: 51,
    iterationScale: 1,
    comparators: ['greedy', 'hanni-3-2-lite'],
    related: ['hanni-3-5', 'hanni-3-2-lite'],
  },
  'hanni-3-5': {
    id: 'hanni-3-5',
    algoId: 'v3.5',
    generation: '3.5',
    displayName: 'Hanni 3.5',
    shortName: '3.5',
    status: 'shipping',
    kicker: 'Hanni 3.5 · Default compute',
    lede: 'The default tier of the move-curve generation, +1.23 points over Hanni 3.2 at the same nominal iteration budget and about 8% more compute actually executed.',
    created:
      'Same curve as the other 3.5 tiers, at roughly 700 iterations of base budget. The shape is normalised to sum to twenty-one so that a seat playing all its pieces spends exactly what a flat allocation would.',
    changed:
      'Two audits set up this generation. One found the deployed search agreeing with a seven-times-deeper oracle only 8% of the time in the opening; the other found that doubling the budget there recovers almost nothing. Those two facts together say where compute is worth moving to, and where it is not worth spending at all.',
    engine: 'bitboard',
    costMsPerMove: 119,
    iterationScale: 2.33,
    comparators: ['greedy', 'hanni-3-2'],
    related: ['hanni-3-5-pro', 'hanni-3-2'],
  },
  'hanni-3-5-pro': {
    id: 'hanni-3-5-pro',
    algoId: 'v3.5-pro',
    generation: '3.5',
    displayName: 'Hanni 3.5 Pro',
    shortName: '3.5 Pro',
    status: 'champion',
    kicker: 'Hanni 3.5 Pro · Shipping champion',
    lede: 'The only tier measured twice on independent seeds: +1.20 and +1.14, pooling to +1.17 [0.60, 1.76] over 200 seeds against Hanni 3.2 Pro. That replication is what the rest of the generation rests on.',
    created:
      'Hanni 3.2 Pro with the move curve and nothing else changed. Roughly 1,380 iterations of base budget, redistributed across the twenty-one own-moves rather than spread evenly over them.',
    changed:
      'Replication mattered here more than the first result did. The Pro Max tier was also measured twice and its estimate halved on the second block, so a single good block is not evidence in this project. Pro reproduced almost exactly, and that is the reason the lower tiers are read as the same effect rather than as lucky draws.',
    engine: 'bitboard',
    costMsPerMove: 227,
    iterationScale: 4.59,
    comparators: ['greedy', 'hanni-3-2-pro'],
    related: ['hanni-3-6-pro-max', 'hanni-3-2-pro'],
  },
  'hanni-3-6-pro-max': {
    id: 'hanni-3-6-pro-max',
    algoId: 'v3.6-pro-max',
    generation: '3.6',
    displayName: 'Hanni 3.6 Pro Max',
    shortName: '3.6 Pro Max',
    status: 'champion',
    kicker: 'Hanni 3.6 Pro Max · Max effort',
    lede: 'The move curve at max effort, +0.84 [0.31, 1.37] over Hanni 3.2 Pro Max across 200 seeds. It needed a slightly larger budget than the other tiers to get there, and the reason is the interesting part.',
    created:
      'At the same nominal budget as Hanni 3.2 Pro Max the curve was worth only +0.41 and did not clear its promotion gate. Raising the iteration budget by a third of a percent per move \u2014 9.2% of executed compute in total, inside this generation\u2019s cap \u2014 took it to +0.84 and past it.',
    changed:
      'A search here stops once the runner-up cannot catch up on visits, because at that point no further simulation can change the move played. Max effort reaches that ceiling sooner relative to what the curve hands it, so 17% of its mid-game allocation was being locked out rather than spent. The larger budget restores compute the smaller tiers were already collecting; it is a different effort level, not a different design.',
    engine: 'bitboard',
    costMsPerMove: 474,
    iterationScale: 8.33,
    comparators: ['greedy', 'hanni-3-2-pro-max'],
    related: ['hanni-3-5-pro', 'hanni-3-2-pro-max'],
  },
  'hanni-3-7-lite': {
    id: 'hanni-3-7-lite',
    algoId: 'v3.7-lite',
    generation: '3.7',
    displayName: 'Hanni 3.7 Lite',
    shortName: '3.7 Lite',
    status: 'shipping',
    kicker: 'Hanni 3.7 \u00b7 Cheapest tier',
    lede: 'The first three moves are played without any search at all, and the engine is both stronger and cheaper for it: +0.58 points over Hanni 3.5 Lite across 400 games-per-seed.',
    created:
      'Every Hanni before this one ran a full tree search on every move of the game. This generation does not: on a seat\u2019s first three placements it takes the move ordering\u2019s top choice and plays it immediately.',
    changed:
      'The saving is largest in relative terms at the cheap end, because a tier with few iterations to spend gains most from not wasting any of them on a decision that was already made.',
    engine: 'bitboard',
    costMsPerMove: 56,
    iterationScale: 1,
    comparators: ['greedy', 'hanni-3-5-lite'],
    related: ['hanni-3-5-lite', 'hanni-3-7', 'hanni-4-1-lite'],
  },
  'hanni-3-7': {
    id: 'hanni-3-7',
    algoId: 'v3.7',
    generation: '3.7',
    displayName: 'Hanni 3.7',
    shortName: '3.7',
    status: 'shipping',
    kicker: 'Hanni 3.7 \u00b7 Default compute',
    lede: 'The default tier of the no-opening-search generation. +0.43 points over Hanni 3.5 at roughly a tenth less time per move.',
    created:
      'Same single change as the rest of the 3.7 line: no tree on a seat\u2019s first three own moves. Everything from the fourth move onward is unchanged.',
    changed:
      'This is the first generation here whose gain comes from doing *less*. Earlier versions bought strength with better allocation or more iterations; this one buys it by not spending them where they cannot change the answer.',
    engine: 'bitboard',
    costMsPerMove: 116,
    iterationScale: 2.33,
    comparators: ['greedy', 'hanni-3-5'],
    related: ['hanni-3-5', 'hanni-3-7-pro', 'hanni-4-1'],
  },
  'hanni-3-7-pro': {
    id: 'hanni-3-7-pro',
    algoId: 'v3.7-pro',
    generation: '3.7',
    displayName: 'Hanni 3.7 Pro',
    shortName: '3.7 Pro',
    status: 'champion',
    kicker: 'Hanni 3.7 Pro \u00b7 Shipping champion',
    lede: '+0.45 points over Hanni 3.5 Pro across 600 games-per-seed, while taking about a tenth less time on each move.',
    created:
      'Hanni 3.5 Pro with the tree switched off for a seat\u2019s first three placements. No network is involved \u2014 a version of this idea that used a learned policy to choose those moves was measurably worse.',
    changed:
      'Its evidence is the weakest of the four tiers, and that is worth saying: part of its sample was collected by extending a promising interim result, which flatters the interval. The cleanly preregistered portion of it is smaller than the headline.',
    engine: 'bitboard',
    costMsPerMove: 211,
    iterationScale: 4.59,
    comparators: ['greedy', 'hanni-3-5-pro'],
    related: ['hanni-3-5-pro', 'hanni-3-7-pro-max', 'hanni-4-1-pro'],
  },
  'hanni-3-7-pro-max': {
    id: 'hanni-3-7-pro-max',
    algoId: 'v3.7-pro-max',
    generation: '3.7',
    displayName: 'Hanni 3.7 Pro Max',
    shortName: '3.7 Pro Max',
    status: 'champion',
    kicker: 'Hanni 3.7 Pro Max \u00b7 Max effort',
    lede: 'The largest gain in the generation: +0.90 points over Hanni 3.6 Pro Max, and about an eighth faster. Two independent blocks, both significant on their own.',
    created:
      'The same change as the other 3.7 tiers, and worth twice as much here. Max effort pours the most iterations into moves whose outcome is already decided, so it has the most to gain from not searching where the choice does not matter.',
    changed:
      'This is the cleanest result of the generation: two disjoint blocks, each significant by itself, with the reproduction rule written down before the second was read.',
    engine: 'bitboard',
    costMsPerMove: 375,
    iterationScale: 8.33,
    comparators: ['greedy', 'hanni-3-6-pro-max'],
    related: ['hanni-3-6-pro-max', 'hanni-3-7-pro', 'hanni-4-1-pro-max'],
  },
  'hanni-4-1-lite': {
    id: 'hanni-4-1-lite',
    algoId: 'v4.1-lite',
    generation: '4.1',
    displayName: 'Hanni 4.1 Lite',
    shortName: '4.1 Lite',
    status: 'shipping',
    kicker: 'Hanni 4.1 · Cheapest tier',
    lede: 'The cheap tier of the first shipping learned-rollout generation. +0.18 against Hanni 3.1 Lite on 40 seeds; the interval spans zero, so this is a transfer, not the promotion result.',
    created:
      'Hanni 3.2 Lite\u2019s iteration budget, Hanni 3.7\u2019s no-tree opening, and a 25% blend of a compiled rollout-policy table trained on counterfactual terminal returns.',
    changed:
      'The table is a place to put a learned rollout policy. It is not why this generation is stronger than Hanni 3.1: an ablation that removed only the table left the Pro-tier result intact.',
    related: ['hanni-3-1-lite', 'hanni-3-7-lite', 'hanni-4-1'],
    engine: 'bitboard',
    costMsPerMove: 83,
    iterationScale: 1,
    comparators: ['greedy', 'hanni-3-1-lite'],
  },
  'hanni-4-1': {
    id: 'hanni-4-1',
    algoId: 'v4.1',
    generation: '4.1',
    displayName: 'Hanni 4.1',
    shortName: '4.1',
    status: 'shipping',
    kicker: 'Hanni 4.1 · Default compute',
    lede: 'The default tier. +0.59 against Hanni 3.1 on 40 seeds, with an interval that spans zero. Whole-game timing was 17% cheaper than that matched 3.1 seat, almost entirely from the inherited opening shortcut.',
    created:
      'Same architecture as the rest of the generation: 3.2-tier search, no tree on a seat\u2019s first three placements, and the validation-selected 25% learned blend inside terminal rollouts.',
    changed:
      'This is a foundation release. The promotion gates asked it to beat the Hanni 3.1 lineup more cheaply and not to regress from Hanni 3.7. They did not ask it to beat Hanni 3.7, and it does not claim to.',
    engine: 'bitboard',
    costMsPerMove: 191,
    iterationScale: 2.33,
    comparators: ['greedy', 'hanni-3-1'],
    related: ['hanni-3-1', 'hanni-3-7', 'hanni-4-1-pro'],
  },
  'hanni-4-1-pro': {
    id: 'hanni-4-1-pro',
    algoId: 'v4.1-pro',
    generation: '4.1',
    displayName: 'Hanni 4.1 Pro',
    shortName: '4.1 Pro',
    status: 'shipping',
    kicker: 'Hanni 4.1 Pro · Foundation',
    lede: 'The measured tier: +1.13 [0.51, 1.74] against Hanni 3.1 Pro over 140 seeds / 560 games, reproduced on a fresh block, at 18% less time per move.',
    created:
      'Hanni 3.2 Pro\u2019s compute, Hanni 3.7\u2019s opening shortcut, and a 25% blend of the compiled rollout-policy student. Blend zero still replays Hanni 3.7 exactly.',
    changed:
      'A head-to-head that removed only the learned table scored \u22120.06 [\u22120.72, 0.61] over 94 seeds. Whatever produced the +1.13 against Hanni 3.1 Pro, it was not the student. The gain is the inherited pair: 60% uniform rollouts and no tree on the first three own-moves.',
    engine: 'bitboard',
    costMsPerMove: 332,
    iterationScale: 4.59,
    comparators: ['greedy', 'hanni-3-1-pro'],
    related: ['hanni-3-1-pro', 'hanni-3-7-pro', 'hanni-4-1-pro-max'],
  },
  'hanni-4-1-pro-max': {
    id: 'hanni-4-1-pro-max',
    algoId: 'v4.1-pro-max',
    generation: '4.1',
    displayName: 'Hanni 4.1 Pro Max',
    shortName: '4.1 Pro Max',
    status: 'shipping',
    kicker: 'Hanni 4.1 Pro Max · Transfer screen',
    lede: '+0.50 against Hanni 3.1 Pro Max on 40 seeds; the interval spans zero. This tier was a reported screen, not a requirement, and it is not a claim against Hanni 3.7 Pro Max.',
    created:
      'The same learned-rollout blend and opening shortcut, at Hanni 3.2 Pro Max\u2019s iteration budget.',
    changed:
      'The four-tier shape against Hanni 3.1 peaks at Pro rather than ramping with compute. All four intervals overlap, so the honest reading is a small positive effect with the evidence concentrated at Pro.',
    engine: 'bitboard',
    costMsPerMove: 586,
    iterationScale: 8,
    comparators: ['greedy', 'hanni-3-1-pro-max'],
    related: ['hanni-3-1-pro-max', 'hanni-3-7-pro-max', 'hanni-4-1-pro'],
  },
  'hanni-4-1-ultra': {
    id: 'hanni-4-1-ultra',
    algoId: 'v4.1-ultra',
    generation: '4.1',
    displayName: 'Hanni 4.1 Ultra',
    shortName: '4.1 Ultra',
    status: 'shipping',
    kicker: 'Hanni 4.1 Ultra \u00b7 Compute tier',
    lede: '+3.39 against Hanni 3.1 Pro Max over 100 seeds, and +1.49 over Hanni 4.1 Pro Max across three disjoint blocks. The strongest engine measured, at 437 ms per move.',
    created:
      'The Hanni 4.1 architecture unchanged, at double Pro Max\u2019s iteration budget \u2014 4,800 iterations at 300 base.',
    changed:
      'A compute tier rather than an architecture: the gain matches what the measured exchange rate predicts for a doubling. Its advantage over Hanni 3.1 Pro Max is larger than chaining through Pro Max suggested, so the direct measurement is the one reported.',
    engine: 'bitboard',
    costMsPerMove: 1070,
    iterationScale: 16,
    comparators: ['greedy', 'hanni-3-1', 'hanni-3-1-pro-max'],
    related: ['hanni-4-1-pro-max', 'hanni-3-1-pro-max', 'hanni-4-1-pro'],
  },
  'hanni-4': {
    id: 'hanni-4',
    algoId: 'v4',
    generation: '4',
    displayName: 'Hanni 4',
    shortName: '4',
    status: 'coming-soon',
    kicker: 'Hanni 4 · Coming soon',
    lede: 'A learned evaluation distilled from Hanni 2 Pro and Hanni 3.1 search. It has not passed the promotion gate, and it is not a shipping champion.',
    created:
      'A small network replaces the rollout at each leaf, trained by listwise distillation from stronger teachers. At 300 iterations it runs in about 57 milliseconds per move — cheap because it no longer simulates the rest of the game.',
    changed:
      'Used as a leaf in place of a rollout it scored −10.62 against Hanni 3.1. Policy-only priors layered on the current champion have not cleared a held-out deployment gate either. The work continues; it is not a release.',
    engine: 'learned',
    costMsPerMove: 57,
    comparators: [],
    related: ['hanni-3-1', 'hanni-3-2-pro'],
  },
};

export interface GenerationNav {
  id: GenerationId;
  label: string;
  href?: string;
  comingSoon?: boolean;
  variants?: Array<{ id: ModelId; label: string; role: string }>;
}

export const GENERATION_NAV: GenerationNav[] = [
  { id: '1', label: 'Hanni 1', href: '/models/hanni-1' },
  {
    id: '2',
    label: 'Hanni 2',
    variants: [
      { id: 'hanni-2-lite', label: 'Hanni 2 Lite', role: 'Fitted eval, truncated rollouts' },
      { id: 'hanni-2-pro', label: 'Hanni 2 Pro', role: 'Full-length rollouts' },
    ],
  },
  {
    id: '3.1',
    label: 'Hanni 3.1',
    variants: [
      { id: 'hanni-3-1-nano', label: 'Hanni 3.1 Nano', role: 'Bitboard, 12-ply rollouts' },
      { id: 'hanni-3-1-lite', label: 'Hanni 3.1 Lite', role: 'Full rollouts, 300 iterations' },
      { id: 'hanni-3-1', label: 'Hanni 3.1', role: 'About 700 iterations' },
      { id: 'hanni-3-1-pro', label: 'Hanni 3.1 Pro', role: 'About 1,380 iterations' },
      { id: 'hanni-3-1-pro-max', label: 'Hanni 3.1 Pro Max', role: 'Max effort' },
    ],
  },
  {
    id: '3.2',
    label: 'Hanni 3.2',
    variants: [
      { id: 'hanni-3-2-lite', label: 'Hanni 3.2 Lite', role: 'ε = 0.60, 300 iterations' },
      { id: 'hanni-3-2', label: 'Hanni 3.2', role: 'Default compute, ε = 0.60' },
      { id: 'hanni-3-2-pro', label: 'Hanni 3.2 Pro', role: 'Shipping champion' },
      { id: 'hanni-3-2-pro-max', label: 'Hanni 3.2 Pro Max', role: 'Max effort' },
    ],
  },
  {
    id: '3.5',
    label: 'Hanni 3.5',
    variants: [
      { id: 'hanni-3-5-lite', label: 'Hanni 3.5 Lite', role: 'Move curve, 300 iterations' },
      { id: 'hanni-3-5', label: 'Hanni 3.5', role: 'About 700 iterations' },
      { id: 'hanni-3-5-pro', label: 'Hanni 3.5 Pro', role: 'Shipping champion, replicated' },
    ],
  },
  {
    id: '3.6',
    label: 'Hanni 3.6',
    variants: [
      { id: 'hanni-3-6-pro-max', label: 'Hanni 3.6 Pro Max', role: 'Max effort, curve at the compute cap' },
    ],
  },
  {
    id: '3.7',
    label: 'Hanni 3.7',
    variants: [
      { id: 'hanni-3-7-lite', label: 'Hanni 3.7 Lite', role: 'No opening search, 300 iterations' },
      { id: 'hanni-3-7', label: 'Hanni 3.7', role: 'About 700 iterations' },
      { id: 'hanni-3-7-pro', label: 'Hanni 3.7 Pro', role: 'Shipping champion' },
      { id: 'hanni-3-7-pro-max', label: 'Hanni 3.7 Pro Max', role: 'Max effort, largest gain' },
    ],
  },
  {
    id: '4.1',
    label: 'Hanni 4.1',
    variants: [
      { id: 'hanni-4-1-lite', label: 'Hanni 4.1 Lite', role: 'Learned rollout blend, 300 iterations' },
      { id: 'hanni-4-1', label: 'Hanni 4.1', role: 'About 700 iterations' },
      { id: 'hanni-4-1-pro', label: 'Hanni 4.1 Pro', role: 'Foundation, reproduced vs 3.1 Pro' },
      { id: 'hanni-4-1-pro-max', label: 'Hanni 4.1 Pro Max', role: 'Transfer screen' },
      { id: 'hanni-4-1-ultra', label: 'Hanni 4.1 Ultra', role: 'Strongest measured, 4,800 iterations' },
    ],
  },
  { id: '4', label: 'Hanni 4', href: '/models/hanni-4', comingSoon: true },
];

export const MODEL_ORDER: ModelId[] = [
  'hanni-1',
  'hanni-2-lite',
  'hanni-2-pro',
  'hanni-3-1-nano',
  'hanni-3-1-lite',
  'hanni-3-1',
  'hanni-3-1-pro',
  'hanni-3-1-pro-max',
  'hanni-3-2-lite',
  'hanni-3-2',
  'hanni-3-2-pro',
  'hanni-3-2-pro-max',
  'hanni-3-5-lite',
  'hanni-3-5',
  'hanni-3-5-pro',
  'hanni-3-6-pro-max',
  'hanni-3-7-lite',
  'hanni-3-7',
  'hanni-3-7-pro',
  'hanni-3-7-pro-max',
  'hanni-4-1-lite',
  'hanni-4-1',
  'hanni-4-1-pro',
  'hanni-4-1-pro-max',
  'hanni-4-1-ultra',
  'hanni-4',
];

export function isModelId(value: string | undefined): value is ModelId {
  return !!value && value in MODELS;
}

export function displayNameOf(id: ComparatorId): string {
  if (id === 'greedy') return 'One-ply ranking';
  return MODELS[id].displayName;
}
