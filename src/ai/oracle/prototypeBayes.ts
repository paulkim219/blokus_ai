import type { GameState, PlaceMove } from '../../engine/types';
import { extractOracleCandidateFeatures } from './styleFeatures';
import type { OracleInteractionState, OracleMoveFeatures } from './types';

const STANDARDIZED_FIELDS: Array<keyof OracleStyleWeights> = [
  'pieceSize',
  'centerAffinity',
  'edgeAffinity',
  'outwardProgress',
  'frontierGain',
  'denial',
  'contact',
  'retaliation',
  'persistence',
];

export interface OracleStyleWeights {
  pieceSize: number;
  centerAffinity: number;
  edgeAffinity: number;
  outwardProgress: number;
  frontierGain: number;
  denial: number;
  contact: number;
  retaliation: number;
  persistence: number;
}

export interface OracleStylePrototype {
  id: string;
  label: string;
  weights: OracleStyleWeights;
}

export const ORACLE_STYLE_PROTOTYPES: OracleStylePrototype[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    weights: {
      pieceSize: 1.2,
      centerAffinity: 0.45,
      edgeAffinity: 0,
      outwardProgress: 0.35,
      frontierGain: 0.75,
      denial: 0.35,
      contact: 0.1,
      retaliation: 0,
      persistence: 0.05,
    },
  },
  {
    id: 'expansion',
    label: 'Expansionist',
    weights: {
      pieceSize: 1.1,
      centerAffinity: 0.3,
      edgeAffinity: -0.15,
      outwardProgress: 0.85,
      frontierGain: 1.65,
      denial: 0.05,
      contact: -0.15,
      retaliation: 0,
      persistence: 0,
    },
  },
  {
    id: 'blocker',
    label: 'Blocker',
    weights: {
      pieceSize: 0.8,
      centerAffinity: 0.35,
      edgeAffinity: 0,
      outwardProgress: 0.45,
      frontierGain: 0.3,
      denial: 1.8,
      contact: 1.1,
      retaliation: 0.1,
      persistence: 0.25,
    },
  },
  {
    id: 'center',
    label: 'Center seeker',
    weights: {
      pieceSize: 0.9,
      centerAffinity: 2.4,
      edgeAffinity: -0.35,
      outwardProgress: 0.4,
      frontierGain: 0.45,
      denial: 0.25,
      contact: 0.15,
      retaliation: 0,
      persistence: 0,
    },
  },
  {
    id: 'edge',
    label: 'Edge runner',
    weights: {
      pieceSize: 0.95,
      centerAffinity: -0.4,
      edgeAffinity: 2.2,
      outwardProgress: 0.5,
      frontierGain: 0.75,
      denial: 0.15,
      contact: -0.1,
      retaliation: 0,
      persistence: 0,
    },
  },
  {
    id: 'retaliator',
    label: 'Retaliator',
    weights: {
      pieceSize: 0.85,
      centerAffinity: 0.25,
      edgeAffinity: 0,
      outwardProgress: 0.35,
      frontierGain: 0.4,
      denial: 0.8,
      contact: 0.7,
      retaliation: 1.6,
      persistence: 0.15,
    },
  },
];

export interface PrototypePrediction {
  probabilities: number[];
  byPrototype: number[][];
  features: OracleMoveFeatures[];
  posterior: number[];
}

export interface PrototypeBeliefOptions {
  temperature?: number;
  learningRate?: number;
  drift?: number;
  actionFloor?: number;
  prior?: number[];
  /** Remove legal-set/phase scale before interpreting a move as style evidence. */
  standardizeFeatures?: boolean;
}

function normalise(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) {
    return values.map(() => 1 / Math.max(1, values.length));
  }
  return values.map((value) => value / total);
}

export function scoreOracleStyle(
  features: OracleMoveFeatures,
  style: OracleStylePrototype,
): number {
  const weights = style.weights;
  return (
    features.pieceSize * weights.pieceSize +
    features.centerAffinity * weights.centerAffinity +
    features.edgeAffinity * weights.edgeAffinity +
    features.outwardProgress * weights.outwardProgress +
    features.frontierGain * weights.frontierGain +
    features.totalDenial * weights.denial +
    features.totalContact * weights.contact +
    features.retaliation * weights.retaliation +
    features.persistence * weights.persistence
  );
}

function featureField(features: OracleMoveFeatures, field: keyof OracleStyleWeights): number {
  if (field === 'denial') {
    return features.totalDenial;
  }
  if (field === 'contact') {
    return features.totalContact;
  }
  return features[field];
}

function writeFeatureField(
  features: OracleMoveFeatures,
  field: keyof OracleStyleWeights,
  value: number,
): void {
  if (field === 'denial') {
    features.totalDenial = value;
  } else if (field === 'contact') {
    features.totalContact = value;
  } else {
    features[field] = value;
  }
}

/**
 * Converts every scalar style feature to a within-legal-set z-score. This removes game phase,
 * branching factor, and seat geometry from the evidence: a profile now records which option the
 * player preferred relative to the choices they actually had.
 */
export function standardizeOracleFeatures(
  features: readonly OracleMoveFeatures[],
): OracleMoveFeatures[] {
  if (features.length === 0) {
    return [];
  }
  const output = features.map((candidate) => ({
    ...candidate,
    targetPressure: [...candidate.targetPressure],
    deniedCorners: [...candidate.deniedCorners],
    edgeContacts: [...candidate.edgeContacts],
    diagonalContacts: [...candidate.diagonalContacts],
  }));
  for (const field of STANDARDIZED_FIELDS) {
    const values = features.map((candidate) => featureField(candidate, field));
    const fieldMean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
      values.reduce((sum, value) => sum + (value - fieldMean) ** 2, 0) / values.length;
    const scale = Math.sqrt(variance);
    for (let index = 0; index < output.length; index += 1) {
      const z = scale > 1e-9 ? (values[index] - fieldMean) / scale : 0;
      writeFeatureField(output[index], field, Math.max(-4, Math.min(4, z)));
    }
  }
  return output;
}

export function softmaxStylePolicy(
  features: readonly OracleMoveFeatures[],
  style: OracleStylePrototype,
  temperature = 0.6,
  actionFloor = 0.01,
): number[] {
  if (features.length === 0) {
    return [];
  }
  const logits = features.map((candidate) => scoreOracleStyle(candidate, style));
  const max = Math.max(...logits);
  const scale = Math.max(1e-6, temperature);
  const raw = logits.map((logit) => Math.exp((logit - max) / scale));
  const policy = normalise(raw);
  const uniform = 1 / policy.length;
  return policy.map((probability) =>
    probability * (1 - actionFloor) + uniform * actionFloor,
  );
}

export class PrototypeBelief {
  readonly prototypes: readonly OracleStylePrototype[];
  readonly prior: number[];
  readonly temperature: number;
  readonly learningRate: number;
  readonly drift: number;
  readonly actionFloor: number;
  readonly standardizeFeatures: boolean;
  private weights: number[];
  observations = 0;

  constructor(
    prototypes: readonly OracleStylePrototype[] = ORACLE_STYLE_PROTOTYPES,
    options: PrototypeBeliefOptions = {},
  ) {
    this.prototypes = prototypes;
    this.prior = normalise(
      options.prior && options.prior.length === prototypes.length
        ? [...options.prior]
        : prototypes.map(() => 1),
    );
    this.weights = [...this.prior];
    this.temperature = options.temperature ?? 0.6;
    this.learningRate = options.learningRate ?? 0.7;
    this.drift = options.drift ?? 0.02;
    this.actionFloor = options.actionFloor ?? 0.01;
    this.standardizeFeatures = options.standardizeFeatures ?? false;
  }

  posterior(): number[] {
    return [...this.weights];
  }

  reset(): void {
    this.weights = [...this.prior];
    this.observations = 0;
  }

  setPosterior(posterior: readonly number[]): void {
    if (posterior.length !== this.prototypes.length) {
      throw new Error('posterior length must match prototype count');
    }
    this.weights = normalise([...posterior]);
  }

  predict(
    state: GameState,
    moves: readonly PlaceMove[],
    interaction: OracleInteractionState,
    posterior: readonly number[] = this.weights,
  ): PrototypePrediction {
    const features = extractOracleCandidateFeatures(state, moves, interaction);
    return this.predictFromFeatures(features, posterior);
  }

  predictFromFeatures(
    features: OracleMoveFeatures[],
    posterior: readonly number[] = this.weights,
  ): PrototypePrediction {
    const prepared = this.standardizeFeatures
      ? standardizeOracleFeatures(features)
      : features;
    const byPrototype = this.prototypes.map((prototype) =>
      softmaxStylePolicy(prepared, prototype, this.temperature, this.actionFloor),
    );
    const mixture = prepared.map((_, moveIndex) =>
      byPrototype.reduce(
        (sum, policy, prototypeIndex) =>
          sum + (posterior[prototypeIndex] ?? 0) * (policy[moveIndex] ?? 0),
        0,
      ),
    );
    return {
      probabilities: normalise(mixture),
      byPrototype,
      features: prepared,
      posterior: [...posterior],
    };
  }

  observe(prediction: PrototypePrediction, playedIndex: number): void {
    if (playedIndex < 0 || playedIndex >= prediction.probabilities.length) {
      throw new Error('played action is missing from the candidate set');
    }
    const updated = this.weights.map((weight, index) => {
      const likelihood = Math.max(1e-12, prediction.byPrototype[index][playedIndex] ?? 0);
      return weight * likelihood ** this.learningRate;
    });
    const bayes = normalise(updated);
    this.weights = normalise(
      bayes.map(
        (weight, index) => weight * (1 - this.drift) + this.prior[index] * this.drift,
      ),
    );
    this.observations += 1;
  }
}
