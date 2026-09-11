import { testBit } from './bitboard';
import { PLACEMENTS } from './placements';
import type { Position } from './position';

interface RawConv {
  kernel: number[];
  bias: number[];
  gamma: number[];
  beta: number[];
}

interface RawDense {
  w: number[];
  b: number[];
}

interface RawMember {
  source?: string;
  mean: number[];
  scale: number[];
  conv: RawConv[];
  vector: RawDense;
  scorer: RawDense;
  head: RawDense;
}

export interface RawPooledPolicyNet {
  kind: 'pooled-policy-v45';
  featureCount: number;
  boardSize: number;
  channels: number;
  vectorWidth: number;
  hiddenWidth: number;
  members: RawMember[];
}

interface Conv {
  kernel: Float32Array;
  bias: Float32Array;
  gamma: Float32Array;
  beta: Float32Array;
}

interface Member {
  mean: Float32Array;
  scale: Float32Array;
  conv: Conv[];
  vectorW: Float32Array;
  vectorB: Float32Array;
  scorerW: Float32Array;
  scorerB: Float32Array;
  headW: Float32Array;
  headB: number;
  boardInput: Float32Array;
  boardA: Float32Array;
  boardB: Float32Array;
  input: Float32Array;
  vector: Float32Array;
  hidden: Float32Array;
}

export interface PooledPolicyNet {
  featureCount: number;
  boardSize: number;
  channels: number;
  vectorWidth: number;
  hiddenWidth: number;
  members: Member[];
}

export function loadPooledPolicyNet(raw: RawPooledPolicyNet): PooledPolicyNet {
  if (
    raw.kind !== 'pooled-policy-v45' ||
    raw.boardSize !== 20 ||
    raw.featureCount !== 256 ||
    raw.members.length === 0
  ) {
    throw new Error('invalid pooled policy network contract');
  }
  const cells = raw.boardSize * raw.boardSize;
  return {
    featureCount: raw.featureCount,
    boardSize: raw.boardSize,
    channels: raw.channels,
    vectorWidth: raw.vectorWidth,
    hiddenWidth: raw.hiddenWidth,
    members: raw.members.map((member) => ({
      mean: new Float32Array(member.mean),
      scale: new Float32Array(member.scale),
      conv: member.conv.map((layer) => ({
        kernel: new Float32Array(layer.kernel),
        bias: new Float32Array(layer.bias),
        gamma: new Float32Array(layer.gamma),
        beta: new Float32Array(layer.beta),
      })),
      vectorW: new Float32Array(member.vector.w),
      vectorB: new Float32Array(member.vector.b),
      scorerW: new Float32Array(member.scorer.w),
      scorerB: new Float32Array(member.scorer.b),
      headW: new Float32Array(member.head.w),
      headB: member.head.b[0],
      boardInput: new Float32Array(cells * 4),
      boardA: new Float32Array(cells * raw.channels),
      boardB: new Float32Array(cells * raw.channels),
      input: new Float32Array(raw.featureCount),
      vector: new Float32Array(raw.vectorWidth),
      hidden: new Float32Array(raw.hiddenWidth),
    })),
  };
}

function convLayer(
  src: Float32Array,
  dst: Float32Array,
  layer: Conv,
  inChannels: number,
  outChannels: number,
): void {
  for (let y = 0; y < 20; y += 1) {
    for (let x = 0; x < 20; x += 1) {
      const outBase = (y * 20 + x) * outChannels;
      for (let o = 0; o < outChannels; o += 1) {
        let sum = layer.bias[o];
        for (let ky = 0; ky < 3; ky += 1) {
          const sy = y + ky - 1;
          if (sy < 0 || sy >= 20) continue;
          for (let kx = 0; kx < 3; kx += 1) {
            const sx = x + kx - 1;
            if (sx < 0 || sx >= 20) continue;
            const srcBase = (sy * 20 + sx) * inChannels;
            const kernelBase = (ky * 3 + kx) * inChannels * outChannels;
            for (let i = 0; i < inChannels; i += 1) {
              sum += src[srcBase + i] * layer.kernel[kernelBase + i * outChannels + o];
            }
          }
        }
        dst[outBase + o] = sum;
      }
      let mean = 0;
      for (let o = 0; o < outChannels; o += 1) mean += dst[outBase + o];
      mean /= outChannels;
      let variance = 0;
      for (let o = 0; o < outChannels; o += 1) {
        const delta = dst[outBase + o] - mean;
        variance += delta * delta;
      }
      const inverse = 1 / Math.sqrt(variance / outChannels + 1e-3);
      for (let o = 0; o < outChannels; o += 1) {
        const value = (dst[outBase + o] - mean) * inverse * layer.gamma[o] + layer.beta[o];
        dst[outBase + o] = value > 0 ? value : 0;
      }
    }
  }
}

/** Encodes a canonical, channel-last 20×20×4 parent board for every ensemble member. */
export function preparePooledPlanes(net: PooledPolicyNet, planes: Float32Array): void {
  if (planes.length !== 20 * 20 * 4) throw new Error('pooled policy expects 20x20x4 planes');
  for (const member of net.members) {
    member.boardInput.set(planes);
    let src = member.boardInput;
    let dst = member.boardA;
    for (let layer = 0; layer < member.conv.length; layer += 1) {
      convLayer(src, dst, member.conv[layer], layer === 0 ? 4 : net.channels, net.channels);
      src = dst;
      dst = dst === member.boardA ? member.boardB : member.boardA;
    }
    // Three layers leave the embedding in boardA; keep the assignment explicit if depth changes.
    if (src !== member.boardA) member.boardA.set(src);
  }
}

/** Builds seat-relative ownership planes and reflects the mover's home corner to the top-left. */
export function preparePooledPosition(net: PooledPolicyNet, position: Position, seat: number): void {
  const planes = net.members[0].boardInput;
  planes.fill(0);
  for (let y = 0; y < 20; y += 1) {
    for (let x = 0; x < 20; x += 1) {
      const cell = y * 20 + x;
      const cx = seat === 2 || seat === 3 ? 19 - x : x;
      const cy = seat === 1 || seat === 2 ? 19 - y : y;
      const base = (cy * 20 + cx) * 4;
      for (let relative = 0; relative < 4; relative += 1) {
        if (testBit(position.own[(seat + relative) % 4], cell)) planes[base + relative] = 1;
      }
    }
  }
  preparePooledPlanes(net, planes);
}

function canonicalCell(cell: number, seat: number): number {
  const x = cell % 20;
  const y = Math.floor(cell / 20);
  const cx = seat === 2 || seat === 3 ? 19 - x : x;
  const cy = seat === 1 || seat === 2 ? 19 - y : y;
  return cy * 20 + cx;
}

function scoreMember(
  net: PooledPolicyNet,
  member: Member,
  placement: number,
  seat: number,
  features: Float32Array,
): number {
  const start = PLACEMENTS.cellStart[placement];
  const end = PLACEMENTS.cellStart[placement + 1];
  const count = Math.max(1, end - start);

  const local = member.boardB.subarray(0, net.channels);
  local.fill(0);
  for (let at = start; at < end; at += 1) {
    const base = canonicalCell(PLACEMENTS.cellList[at], seat) * net.channels;
    for (let channel = 0; channel < net.channels; channel += 1) {
      local[channel] += member.boardA[base + channel];
    }
  }
  for (let channel = 0; channel < net.channels; channel += 1) local[channel] /= count;

  for (let i = 0; i < net.featureCount; i += 1) {
    member.input[i] = (features[i] - member.mean[i]) / member.scale[i];
  }
  for (let o = 0; o < net.vectorWidth; o += 1) {
    let sum = member.vectorB[o];
    for (let i = 0; i < net.featureCount; i += 1) {
      sum += member.input[i] * member.vectorW[i * net.vectorWidth + o];
    }
    member.vector[o] = sum > 0 ? sum : 0;
  }
  for (let o = 0; o < net.hiddenWidth; o += 1) {
    let sum = member.scorerB[o];
    for (let i = 0; i < net.channels; i += 1) {
      sum += local[i] * member.scorerW[i * net.hiddenWidth + o];
    }
    for (let i = 0; i < net.vectorWidth; i += 1) {
      sum += member.vector[i] * member.scorerW[(net.channels + i) * net.hiddenWidth + o];
    }
    member.hidden[o] = sum > 0 ? sum : 0;
  }
  let score = member.headB;
  for (let i = 0; i < net.hiddenWidth; i += 1) score += member.hidden[i] * member.headW[i];
  return score;
}

/** Scores one candidate; multiple members are averaged in logit space. */
export function scorePooledPlacement(
  net: PooledPolicyNet,
  placement: number,
  seat: number,
  features: Float32Array,
): number {
  let score = 0;
  for (const member of net.members) score += scoreMember(net, member, placement, seat, features);
  return score / net.members.length;
}

/**
 * Scores from the individual ensemble members.
 *
 * Direct-action controllers need epistemic disagreement, not just the ensemble mean: a move on
 * which three independently trained members disagree is exactly where the controller should pay
 * for search. Keep the ordinary mean-scoring path above as the hot-path API; this allocation-heavy
 * diagnostic is called only once per root by offline calibration and selective-search gates.
 */
export function scorePooledPlacementMembers(
  net: PooledPolicyNet,
  placement: number,
  seat: number,
  features: Float32Array,
): number[] {
  return net.members.map((member) => scoreMember(net, member, placement, seat, features));
}

const registry = new Map<string, PooledPolicyNet>();

export function registerPooledPolicyNet(path: string, net: PooledPolicyNet): void {
  registry.set(path, net);
}

export function pooledPolicyNetFor(path: string | undefined): PooledPolicyNet | null {
  return path ? registry.get(path) ?? null : null;
}

export function isPooledPolicyNetRegistered(path: string): boolean {
  return registry.has(path);
}
