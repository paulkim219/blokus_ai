import { generateLegalMoves, moveKey } from '../../engine/game';
import type { GameState, PlaceMove } from '../../engine/types';
import {
  advanceOracleInteraction,
  cloneOracleInteractionState,
  createOracleInteractionState,
  oracleSeat,
} from './interaction';
import { ORACLE_STYLE_PROTOTYPES, PrototypeBelief } from './prototypeBayes';
import { extractOracleCandidateFeatures } from './styleFeatures';
import type { OracleProfileMode, OracleSearchSnapshot } from './types';

export interface OracleRuntimeOptions {
  temperature?: number;
}

/**
 * Owns the four real-game beliefs. It is intentionally outside every search tree: only moves that
 * actually happened call `observe`, while a search receives a deep snapshot of the current state.
 */
export class OracleRuntimeTracker {
  private readonly beliefs: PrototypeBelief[];
  private interaction = createOracleInteractionState();

  constructor(options: OracleRuntimeOptions = {}) {
    this.beliefs = Array.from({ length: 4 }, () =>
      new PrototypeBelief(ORACLE_STYLE_PROTOTYPES, {
        temperature: options.temperature ?? 0.6,
        learningRate: 0.7,
        drift: 0.02,
        actionFloor: 0.01,
        standardizeFeatures: true,
      }),
    );
  }

  observe(state: GameState, played: PlaceMove | null): void {
    if (!played) {
      this.interaction = advanceOracleInteraction(this.interaction, null);
      return;
    }

    const source = oracleSeat(played.color);
    const candidates = generateLegalMoves(state, played.color);
    const playedKey = moveKey(played);
    let playedIndex = candidates.findIndex((move) => moveKey(move) === playedKey);
    // A search shortlist must never make the observer reject a legal action. The exact generator
    // should contain it; retaining this guard makes the runtime safe if a future generator changes.
    if (playedIndex < 0) {
      candidates.push(played);
      playedIndex = candidates.length - 1;
    }
    const features = extractOracleCandidateFeatures(state, candidates, this.interaction);
    const belief = this.beliefs[source];
    const prediction = belief.predictFromFeatures(features);
    belief.observe(prediction, playedIndex);
    this.interaction = advanceOracleInteraction(this.interaction, features[playedIndex]);
  }

  snapshot(mode: OracleProfileMode): OracleSearchSnapshot {
    const learned = this.beliefs.map((belief) => belief.posterior());
    const posteriors = learned.map((posterior, seat) => {
      if (mode === 'fixed') {
        return [...this.beliefs[seat].prior];
      }
      if (mode === 'shuffled') {
        return [...learned[(seat + 1) % learned.length]];
      }
      return [...posterior];
    });
    return {
      mode,
      posteriors,
      observations: this.beliefs.map((belief) => belief.observations),
      interaction: cloneOracleInteractionState(this.interaction),
    };
  }
}
