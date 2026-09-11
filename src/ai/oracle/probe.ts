import { generateLegalMoves, moveKey } from '../../engine/game';
import type { GameState, PlaceMove } from '../../engine/types';
import {
  advanceOracleInteraction,
  createOracleInteractionState,
  oracleSeat,
} from './interaction';
import { ORACLE_STYLE_PROTOTYPES, PrototypeBelief } from './prototypeBayes';
import { extractOracleCandidateFeatures } from './styleFeatures';

export interface OracleProbeOptions {
  temperature: number;
  warmupObservations: number;
  standardizeFeatures?: boolean;
}

export interface OracleProbeMetrics {
  decisions: number;
  adaptiveNll: number;
  fixedNll: number;
  shuffledNll: number;
  uniformNll: number;
  adaptiveTop1: number;
  adaptiveTop5: number;
}

export interface OracleProbeResult {
  all: OracleProbeMetrics;
  warm: OracleProbeMetrics;
  byLabel: Record<string, OracleProbeMetrics>;
  missingPlayedActions: number;
}

interface Accumulator {
  decisions: number;
  adaptiveNll: number;
  fixedNll: number;
  shuffledNll: number;
  uniformNll: number;
  adaptiveTop1: number;
  adaptiveTop5: number;
}

function emptyAccumulator(): Accumulator {
  return {
    decisions: 0,
    adaptiveNll: 0,
    fixedNll: 0,
    shuffledNll: 0,
    uniformNll: 0,
    adaptiveTop1: 0,
    adaptiveTop5: 0,
  };
}

function normalise(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  return values.map((value) => value / total);
}

function mixture(byPrototype: number[][], posterior: readonly number[]): number[] {
  if (byPrototype.length === 0) {
    return [];
  }
  return normalise(
    byPrototype[0].map((_, moveIndex) =>
      byPrototype.reduce(
        (sum, policy, prototypeIndex) =>
          sum + (posterior[prototypeIndex] ?? 0) * (policy[moveIndex] ?? 0),
        0,
      ),
    ),
  );
}

function nll(probability: number): number {
  return -Math.log(Math.max(1e-12, probability));
}

function record(
  accumulator: Accumulator,
  adaptive: number[],
  fixed: number[],
  shuffled: number[],
  actual: number,
): void {
  accumulator.decisions += 1;
  accumulator.adaptiveNll += nll(adaptive[actual]);
  accumulator.fixedNll += nll(fixed[actual]);
  accumulator.shuffledNll += nll(shuffled[actual]);
  accumulator.uniformNll += Math.log(Math.max(1, adaptive.length));
  const actualProbability = adaptive[actual];
  const rank = 1 + adaptive.filter((value) => value > actualProbability + 1e-12).length;
  accumulator.adaptiveTop1 += rank === 1 ? 1 : 0;
  accumulator.adaptiveTop5 += rank <= 5 ? 1 : 0;
}

function finalise(accumulator: Accumulator): OracleProbeMetrics {
  const count = Math.max(1, accumulator.decisions);
  return {
    decisions: accumulator.decisions,
    adaptiveNll: accumulator.adaptiveNll / count,
    fixedNll: accumulator.fixedNll / count,
    shuffledNll: accumulator.shuffledNll / count,
    uniformNll: accumulator.uniformNll / count,
    adaptiveTop1: accumulator.adaptiveTop1 / count,
    adaptiveTop5: accumulator.adaptiveTop5 / count,
  };
}

/** Prediction-only observer. It never chooses or changes an engine move. */
export class OraclePredictionProbe {
  private readonly beliefs: PrototypeBelief[];
  private readonly warmupObservations: number;
  private interaction = createOracleInteractionState();
  private readonly all = emptyAccumulator();
  private readonly warm = emptyAccumulator();
  private readonly byLabel = new Map<string, Accumulator>();
  private missingPlayedActions = 0;

  constructor(options: OracleProbeOptions) {
    this.warmupObservations = options.warmupObservations;
    this.beliefs = Array.from({ length: 4 }, () =>
      new PrototypeBelief(ORACLE_STYLE_PROTOTYPES, {
        temperature: options.temperature,
        learningRate: 0.7,
        drift: 0.02,
        actionFloor: 0.01,
        standardizeFeatures: options.standardizeFeatures,
      }),
    );
  }

  observe(state: GameState, played: PlaceMove | null, label: string): void {
    if (!played) {
      this.interaction = advanceOracleInteraction(this.interaction, null);
      return;
    }
    const source = oracleSeat(played.color);
    const candidates = generateLegalMoves(state, played.color);
    const key = moveKey(played);
    let actual = candidates.findIndex((move) => moveKey(move) === key);
    if (actual < 0) {
      candidates.push(played);
      actual = candidates.length - 1;
      this.missingPlayedActions += 1;
    }
    const features = extractOracleCandidateFeatures(state, candidates, this.interaction);
    const belief = this.beliefs[source];
    const prediction = belief.predictFromFeatures(features);
    const fixed = mixture(prediction.byPrototype, belief.prior);
    const shuffled = mixture(
      prediction.byPrototype,
      this.beliefs[(source + 1) % this.beliefs.length].posterior(),
    );
    record(this.all, prediction.probabilities, fixed, shuffled, actual);
    const warmed = belief.observations >= this.warmupObservations;
    if (warmed) {
      record(this.warm, prediction.probabilities, fixed, shuffled, actual);
      const labelAccumulator = this.byLabel.get(label) ?? emptyAccumulator();
      record(labelAccumulator, prediction.probabilities, fixed, shuffled, actual);
      this.byLabel.set(label, labelAccumulator);
    }
    belief.observe(prediction, actual);
    this.interaction = advanceOracleInteraction(this.interaction, features[actual]);
  }

  result(): OracleProbeResult {
    return {
      all: finalise(this.all),
      warm: finalise(this.warm),
      byLabel: Object.fromEntries(
        [...this.byLabel.entries()].map(([label, accumulator]) => [label, finalise(accumulator)]),
      ),
      missingPlayedActions: this.missingPlayedActions,
    };
  }
}
