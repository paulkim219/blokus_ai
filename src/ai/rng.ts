/**
 * Deterministic PRNG for search rollouts and playouts.
 *
 * Self-play comparisons are dominated by variance: two configs that differ by a point or two per
 * game need hundreds of games to separate under independent randomness. Seeding every stochastic
 * decision lets a tournament replay the *same* rollout luck for every candidate (common random
 * numbers), which is the cheapest variance reduction available here.
 *
 * The UI keeps its previous behaviour: the module starts on an unpredictable seed.
 */

export type Rng = () => number;

/** mulberry32 — small state, good enough distribution for rollout choices, fast. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let activeSeed = Math.floor(Math.random() * 0xffffffff) >>> 0;
let active: Rng = createRng(activeSeed);

export function setSeed(seed: number): void {
  activeSeed = seed >>> 0;
  active = createRng(activeSeed);
}

export function getSeed(): number {
  return activeSeed;
}

/** Draw from the active stream. Replaces `Math.random()` everywhere inside the engine. */
export function random(): number {
  return active();
}

export function randomInt(bound: number): number {
  return Math.floor(active() * bound);
}

/** Run `fn` on a fresh stream, then restore whatever stream was active before. */
export function withSeed<T>(seed: number, fn: () => T): T {
  const previousSeed = activeSeed;
  const previous = active;
  setSeed(seed);
  try {
    return fn();
  } finally {
    activeSeed = previousSeed;
    active = previous;
  }
}
