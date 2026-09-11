/**
 * Forward pass for the v4 learned evaluation, and the loader for the weights `ml/train_v4.py`
 * exports.
 *
 * This runs at every MCTS leaf, four times (once per seat perspective), so it is written as flat
 * `Float32Array` matrix-vector products with no allocation after load. The trained trunk is
 * 168→256→128→64→1 with layer norm, which is ~85k multiply-adds per seat — roughly 60 µs for all
 * four seats, against the 41 ms/move v3 spends at 300 iterations. That cost ratio is the reason the
 * network is an MLP over precomputed features rather than a convnet over board planes.
 */

interface Layer {
  /** Row-major `out × in`, so each output is one contiguous dot product. */
  w: Float32Array;
  b: Float32Array;
  gamma: Float32Array;
  beta: Float32Array;
  inSize: number;
  outSize: number;
}

export interface Net {
  featureCount: number;
  mean: Float32Array;
  scale: Float32Array;
  layers: Layer[];
  headW: Float32Array;
  headB: Float32Array;
  /** Optional direct standardised-input → mean-output path for residual MLPs. */
  skipW: Float32Array | null;
  skipB: Float32Array | null;
  /** Value-vector width: the net predicts every seat's margin from one seat-relative input. */
  outputs: number;
  out: Float32Array;
  /** Scratch, sized to the widest layer; reused across calls. */
  bufA: Float32Array;
  bufB: Float32Array;
  input: Float32Array;
  meta: Record<string, unknown>;
}

interface RawLayer {
  w: number[];
  b: number[];
  gamma: number[];
  beta: number[];
  in: number;
  out: number;
}

interface RawNet {
  featureCount: number;
  featureNames?: string[];
  mean: number[];
  scale: number[];
  layers: RawLayer[];
  head: { w: number[]; b: number[] };
  skipHead?: { w: number[]; b: number[] };
  [key: string]: unknown;
}

export function loadNet(raw: RawNet): Net {
  if (raw.featureCount <= 0 || raw.mean.length !== raw.featureCount || raw.scale.length !== raw.featureCount) {
    throw new Error(`invalid network feature contract: ${raw.featureCount} inputs`);
  }
  const layers: Layer[] = raw.layers.map((layer) => ({
    w: new Float32Array(layer.w),
    b: new Float32Array(layer.b),
    gamma: new Float32Array(layer.gamma),
    beta: new Float32Array(layer.beta),
    inSize: layer.in,
    outSize: layer.out,
  }));
  const widest = Math.max(raw.featureCount, ...layers.map((layer) => layer.outSize));
  return {
    featureCount: raw.featureCount,
    mean: new Float32Array(raw.mean),
    scale: new Float32Array(raw.scale),
    layers,
    headW: new Float32Array(raw.head.w),
    headB: new Float32Array(raw.head.b),
    skipW: raw.skipHead ? new Float32Array(raw.skipHead.w) : null,
    skipB: raw.skipHead ? new Float32Array(raw.skipHead.b) : null,
    outputs: raw.head.b.length,
    out: new Float32Array(raw.head.b.length),
    bufA: new Float32Array(widest),
    bufB: new Float32Array(widest),
    input: new Float32Array(raw.featureCount),
    meta: raw as unknown as Record<string, unknown>,
  };
}

/**
 * Evaluates one already-extracted feature vector, returning the net's own output buffer: one margin
 * per seat, in the seat-relative order `writeFeatures` used — index 0 is the perspective seat.
 *
 * `features` is standardised into the net's input buffer, so the caller's array is not modified,
 * and the returned array is overwritten by the next call.
 */
export function forward(net: Net, features: Float32Array): Float32Array {
  const { input, mean, scale } = net;
  for (let i = 0; i < net.featureCount; i += 1) {
    input[i] = (features[i] - mean[i]) / scale[i];
  }

  let src = input;
  let dst = net.bufA;
  let spare = net.bufB;

  for (const layer of net.layers) {
    const { w, b, gamma, beta, inSize, outSize } = layer;
    // Dense
    for (let o = 0; o < outSize; o += 1) {
      const row = o * inSize;
      let sum = b[o];
      for (let i = 0; i < inSize; i += 1) {
        sum += w[row + i] * src[i];
      }
      dst[o] = sum;
    }
    // Layer norm over the output, then ReLU — the same order Keras applied in training.
    let m = 0;
    for (let o = 0; o < outSize; o += 1) {
      m += dst[o];
    }
    m /= outSize;
    let v = 0;
    for (let o = 0; o < outSize; o += 1) {
      const d = dst[o] - m;
      v += d * d;
    }
    const inv = 1 / Math.sqrt(v / outSize + 1e-3);
    for (let o = 0; o < outSize; o += 1) {
      const normed = (dst[o] - m) * inv * gamma[o] + beta[o];
      dst[o] = normed > 0 ? normed : 0;
    }

    const next = src === input ? spare : src;
    src = dst;
    dst = next;
    spare = dst;
  }

  // A distilled linear student has no hidden layers: its head reads the standardised input
  // directly. Supporting that form avoids paying for a variance trunk when deployment needs only
  // the validated ridge mean.
  const last = net.layers.length > 0 ? net.layers[net.layers.length - 1].outSize : net.featureCount;
  const { out, headW, headB, outputs } = net;
  for (let o = 0; o < outputs; o += 1) {
    const row = o * last;
    let sum = headB[o];
    for (let i = 0; i < last; i += 1) {
      sum += headW[row + i] * src[i];
    }
    if (net.skipW !== null && net.skipB !== null && o < net.skipB.length) {
      const skipRow = o * net.featureCount;
      sum += net.skipB[o];
      for (let i = 0; i < net.featureCount; i += 1) {
        sum += net.skipW[skipRow + i] * input[i];
      }
    }
    out[o] = sum;
  }
  return out;
}

/**
 * Path-keyed registry. The engine must stay importable by the browser build, so nothing here
 * touches the filesystem — Node entry points call `registerNet` (see `scripts/lib/netPreload.ts`)
 * before play starts, and the search does a pure map lookup at every leaf.
 *
 * The weights file is ~1.8 MB, far too large to inline into the JSON config the tournament pool
 * ships to each worker process, so a config names the file and each worker loads it once.
 */
const registry = new Map<string, Net>();

export function registerNet(path: string, net: Net): void {
  registry.set(path, net);
}

export function netFor(path: string | undefined): Net | null {
  return path ? registry.get(path) ?? null : null;
}

/** Every path a config has asked for but no one has registered — used to fail loudly at startup. */
export function isNetRegistered(path: string): boolean {
  return registry.has(path);
}
