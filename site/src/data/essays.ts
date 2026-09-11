export interface Essay {
  slug: string;
  title: string;
  kicker: string;
  lede: string;
  sections: Array<{ heading: string; paragraphs: string[]; list?: string[] }>;
}

export const ESSAYS: Essay[] = [
  {
    slug: 'leaf-and-weights',
    title: 'Where strength actually comes from',
    kicker: 'The finding',
    lede: 'In this implementation, how a leaf’s value is obtained, and the evaluation weights, decide outcomes. The tree policy barely registers.',
    sections: [
      {
        heading: 'The measurement, not the architecture',
        paragraphs: [
          'The first written design for this engine spent most of its length on algorithm selection: multi-player tree search, progressive widening, transpositions, an exact endgame packer. Weights were a subordinate clause — “tuned by self-play.” That allocation was backwards.',
          'When the design was implemented and measured, two changes dominated. Playing rollouts to the end of the game rather than truncating them at twelve plies was worth about +4.7 points at equal compute. Fitting evaluation weights by cross-entropy self-play, with the features unchanged, was worth about +4.5. A fractional tie-break in the territory statistic added +0.96. Selection rules, widening, packers, and guessed seat constants were null, small, or negative.',
        ],
      },
      {
        heading: 'How a comparison is made',
        paragraphs: [
          'Four-player Blokus is scored, not won. The harness reports the challenger’s score minus the mean of the other three seats, with the challenger rotated through every colour on each seed. Intervals are bootstrap 95% confidence intervals. Seeds used in fitting are not used in confirmation. A bake-off winner is a hypothesis; a 400-game held-out run is a measurement.',
          'That protocol changed on 17 August 2026. Numbers recorded under the older statistic — hero minus the best opponent, blue seat only — are not plotted on the same axes.',
        ],
      },
      {
        heading: 'Compute is part of the claim',
        paragraphs: [
          'Every named Hanni carries a cost per move. Iteration-matched comparisons between a cheap bitboard engine and an expensive object-board engine are not fair in the direction people assume. Hanni 3.1 Lite at 300 iterations costs about 85 milliseconds; Hanni 2 Pro at the same iteration count costs about 1,500. The record that had the bitboard line behind Pro was measured while Pro spent sixteen times as long. Give 3.1 Pro the iterations it can actually afford, and it wins by +2.01 [1.00, 3.02] over 400 games, at about a quarter of the wall-clock.',
        ],
      },
      {
        heading: 'Adopt one mechanism at a time',
        paragraphs: [
          'A full-stack replacement of a tuned incumbent starts with a handicap of about two points that has nothing to do with the design: that is what fitting the weights recovered on the unpublished draft engine. New mechanisms go onto the measured champion, one axis at a time, and nothing is compared until it has been through the same fitting the incumbent had.',
        ],
      },
    ],
  },
  {
    slug: 'how-the-design-was-tested',
    title: 'How the design was tested',
    kicker: 'Validation',
    lede: 'An unpublished design draft underperformed a fitted incumbent. The postmortem was not that the ideas were silly. It was that untested assertions and established results had been written in the same voice.',
    sections: [
      {
        heading: 'What the draft got right, and what it did not',
        paragraphs: [
          'The draft specified a bitboard engine, a multi-player backup, territory features, phase and seat weights, and short ε-greedy playouts. Implemented and measured against a fitted generation-2 incumbent, the evaluation sat several points behind. Fitting its weights — no structural change — recovered a large part of that gap. The remaining search-level deficit was not in the tree policy the draft had emphasized.',
        ],
      },
      {
        heading: 'Two load-bearing corrections',
        paragraphs: [
          'Twelve hand-set changes were tried. Two helped, and both changed what a quantity computes rather than what it is worth. Sharing ties in the territory statistic was worth about a point at evaluation level. Playing rollouts to a real terminal score, instead of reading a heuristic after twelve plies, was worth more than five points in a truncation sweep: first-place rate moved from 25% at twelve plies to 52% when the simulation ran to the end.',
          'The incumbent had been truncating too. Once both engines played the game out, the “parity” claim against the old champion was withdrawn. Truncation had been hiding a comparison between two handicapped players.',
        ],
        list: [
          'Truncation at 12 plies: baseline, 25% first place',
          '24 plies: +3.57, 45% first place',
          '36 plies: +5.13, 50% first place',
          '84 plies (full): +5.71, 52.1% first place',
        ],
      },
      {
        heading: 'Ablations do not compose',
        paragraphs: [
          'Several results reversed when an unrelated parameter changed. Pooling playout candidates from four open corners helped under truncation and vanished once rollouts ran to the end. Bundling several significantly negative changes produced a much smaller combined loss than additivity predicted. Single-axis results describe the neighbourhood of the base config, not a decomposable sum.',
        ],
      },
    ],
  },
  {
    slug: 'hanni-3-2',
    title: 'Hanni 3.2',
    kicker: 'Release note',
    lede: 'The champion moved because simulated games got noisier, not because the tree got larger.',
    sections: [
      {
        heading: 'What shipped',
        paragraphs: [
          'Hanni 3.2 keeps the 3.1 architecture and compute tiers. The only change is the mixture inside full-length terminal rollouts: 60% of simulated moves are drawn uniformly rather than 15%. Canonical Hanni 3.2, 3.2 Pro, and 3.2 Pro Max are those three iteration budgets with that mixture.',
        ],
      },
      {
        heading: 'The blocks that justified a name',
        paragraphs: [
          'At the Pro tier, three disjoint blocks pooled to +0.70 [0.10, 1.31] over 156 seeds / 624 games against Hanni 3.1 Pro. The mixture transferred at the default tier. At Pro Max, a first block of +1.38 and an independent replication of +0.68 pooled to +0.88 [0.25, 1.54] over 140 seeds / 560 games, with 30.9% first place. Both independent Pro Max point estimates were positive, and the pooled interval excluded zero at the same iteration budget.',
          'Fully uniform rollouts scored only +0.36 with an interval that spanned zero, so the evidence favours an interior mixture rather than removing rollout knowledge. A phase-specific schedule did not beat the simple all-phase 60% configuration in a direct confirmation.',
        ],
      },
      {
        heading: 'What was tried and rejected',
        paragraphs: [
          'An equal-compute two-tree ensemble was significantly harmful at −2.99. Learned policy-only priors, MAST, RAVE, first-play urgency, and variance-tuned selection either failed outright or collapsed under larger held-out blocks after looking promising in a screen. Those nulls are part of the release: each idea had a plausible mechanism, and none of them earned a name.',
        ],
      },
    ],
  },
  {
    slug: 'hanni-4',
    title: 'Hanni 4 is not a release',
    kicker: 'In progress',
    lede: 'A distilled network can run in 57 milliseconds a move. Used as a leaf in place of a rollout, it lost by more than ten points. That is the whole public claim.',
    sections: [
      {
        heading: 'What was trained',
        paragraphs: [
          'Hanni 4 is a small network trained by listwise distillation from Hanni 2 Pro and Hanni 3.1 teachers, then dropped into the 3.1 search shell in place of a rollout. The attraction is cost: without a simulation to the end of the game, 300 iterations take about 57 milliseconds.',
        ],
      },
      {
        heading: 'What was measured',
        paragraphs: [
          'As a leaf replacement the network scored −10.62 [−12.10, −9.23] against Hanni 3.1 over 100 games. Policy-only priors, hybrids, and later representation experiments produced offline ranking gains that did not survive an online promotion gate. None of those configurations is shipped, and none of them should be read as a cheaper champion.',
        ],
      },
    ],
  },
  {
    slug: 'hanni-4-1',
    title: 'Hanni 4.1 is a foundation, not a student result',
    kicker: 'Release note',
    lede: 'The first shipping learned-rollout generation beats the matched Hanni 3.1 tier more cheaply. A head-to-head that removed only the learned table left that gain intact.',
    sections: [
      {
        heading: 'What shipped',
        paragraphs: [
          'Hanni 4.1 keeps Hanni 3.2’s iteration budgets and Hanni 3.7’s no-tree opening, then mixes a compiled rollout-policy table at 25% into terminal rollouts. Canonical Hanni 4.1 Lite, 4.1, 4.1 Pro, and 4.1 Pro Max are those four compute tiers. Blend zero still replays Hanni 3.7 exactly.',
        ],
      },
      {
        heading: 'The block that justified a name',
        paragraphs: [
          'Against Hanni 3.1 Pro, two disjoint blocks pooled to +1.13 [0.51, 1.74] over 140 seeds / 560 games. Both independent point estimates were positive and both intervals cleared zero. Whole-game timing at that tier was 18% cheaper than the matched Hanni 3.1 Pro seat. Lite, default, and Pro Max transferred with positive point estimates whose intervals still span zero.',
          'The promotion gates asked for a safe place to put a learned rollout policy, a cheaper win over the Hanni 3.1 lineup, and no material regression from Hanni 3.7. They did not ask this generation to beat Hanni 3.7, and it does not claim to.',
        ],
      },
      {
        heading: 'What the student did not do',
        paragraphs: [
          'A 94-seed head-to-head that differed only by removing the learned table scored −0.06 [−0.72, 0.61]. That interval excludes the release’s own +1.13. The strength is the inherited pair: 60% uniform moves inside terminal rollouts, and no tree on a seat’s first three placements. The student is strength-neutral and costs midgame time. Offline candidate regret fell on holdout games and bought nothing online — the same signature as earlier learned-prior work.',
        ],
      },
    ],
  },
];

export function essayBySlug(slug: string | undefined): Essay | undefined {
  return ESSAYS.find((essay) => essay.slug === slug);
}
