import { useId, useState, type ReactNode } from 'react';
import { MODELS, MODEL_ORDER, type GenerationId, type ModelId } from '../data/models';
import {
  CROP_FROM,
  CROP_TO,
  FAMILY_COLOR,
  FAMILY_LABEL,
  MODEL_COLOR,
  croppedDelta,
  croppedHigh,
  croppedLow,
  croppedTurns,
  trajectoryFor,
  v31TrajectoryFor,
  v32ProTrajectoryFor,
  type GreedyTrajectoryResult,
} from '../data/benchmarks';
import { formatAdvantage } from '../data/comparisons';

const WIDTH = 760;
const OVERLAY_HEIGHT = 580;
const PARETO_HEIGHT = 500;

interface HoverInfo {
  x: number;
  y: number;
  title: string;
  color: string;
  lines: string[];
}

function yTicks(min: number, max: number): number[] {
  const span = Math.max(max - min, 1);
  const step = span <= 6 ? 1 : span <= 12 ? 2 : span <= 24 ? 4 : 5;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + 1e-9; value += step) {
    ticks.push(value);
  }
  if (min <= 0 && max >= 0 && !ticks.some((tick) => Math.abs(tick) < 1e-9)) {
    ticks.push(0);
  }
  return [...new Set(ticks)].sort((a, b) => a - b);
}

function msTicks(maxMs: number): number[] {
  const step = maxMs > 1200 ? 300 : maxMs > 600 ? 150 : maxMs > 200 ? 50 : 25;
  const ticks: number[] = [];
  for (let value = 0; value <= maxMs + 1e-9; value += step) {
    ticks.push(value);
  }
  return ticks;
}

function linePath(xs: number[], ys: number[]): string {
  return xs
    .map((x, index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[index]!.toFixed(1)}`)
    .join(' ');
}

function bandPath(xs: number[], highs: number[], lows: number[]): string {
  const up = xs.map((x, index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${highs[index]!.toFixed(1)}`);
  const down = [...xs]
    .reverse()
    .map((x, index) => {
      const y = lows[lows.length - 1 - index]!;
      return `L${x.toFixed(1)},${y.toFixed(1)}`;
    });
  return `${up.join(' ')} ${down.join(' ')} Z`;
}

function spreadLabels(
  items: Array<{ key: string; y: number }>,
  minY: number,
  maxY: number,
  gap: number,
): Map<string, number> {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  const ys = sorted.map((item) => item.y);
  for (let i = 1; i < ys.length; i += 1) {
    const previous = ys[i - 1]!;
    if (ys[i]! < previous + gap) {
      ys[i] = previous + gap;
    }
  }
  const last = ys[ys.length - 1];
  if (last != null && last > maxY) {
    const overflow = last - maxY;
    for (let i = 0; i < ys.length; i += 1) ys[i] = ys[i]! - overflow;
  }
  const first = ys[0];
  if (first != null && first < minY) {
    const underflow = minY - first;
    for (let i = 0; i < ys.length; i += 1) ys[i] = ys[i]! + underflow;
  }
  const placed = new Map<string, number>();
  sorted.forEach((item, index) => {
    placed.set(item.key, ys[index]!);
  });
  return placed;
}

function HoverCard({
  hover,
  width,
  height,
}: {
  hover: HoverInfo | null;
  width: number;
  height: number;
}) {
  if (!hover) return null;
  const left = Math.min(86, Math.max(2, (hover.x / width) * 100));
  const top = Math.min(82, Math.max(2, (hover.y / height) * 100 - 14));
  return (
    <div className="chart-hover-card" style={{ left: `${left}%`, top: `${top}%` }}>
      <strong style={{ color: hover.color }}>{hover.title}</strong>
      {hover.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

export function ChartWell({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <figure className="chart-well">
      <figcaption>
        <p className="chart-well-title">{title}</p>
        <p className="chart-well-caption">{caption}</p>
      </figcaption>
      {children}
    </figure>
  );
}

export function ChartEmpty({ children }: { children: string }) {
  return <p className="bench-empty">{children}</p>;
}

export function ScoreDeltaChart({
  ids,
  series,
  featured,
  axisLabel = 'Score Δ vs greedy',
  empty = '400-game trajectories are not on disk yet. The overlay will fill in as each block finishes.',
}: {
  ids?: ModelId[];
  series?: Array<{ id: ModelId; row: GreedyTrajectoryResult }>;
  featured?: ModelId;
  axisLabel?: string;
  empty?: string;
}) {
  const clipId = `clip-${useId().replace(/:/g, '')}`;
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const rows =
    series ??
    (ids ?? [])
      .map((id) => {
        const row = trajectoryFor(id);
        return row ? { id, row } : null;
      })
      .filter((entry): entry is { id: ModelId; row: GreedyTrajectoryResult } => entry != null);

  if (rows.length === 0) {
    return <ChartEmpty>{empty}</ChartEmpty>;
  }

  const height = OVERLAY_HEIGHT;
  const margin = { top: 18, right: 118, bottom: 44, left: 48 };
  const innerW = WIDTH - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const xMin = CROP_FROM;
  const xMax = CROP_TO;
  const samples = rows.flatMap(({ id, row }) => {
    const delta = croppedDelta(row);
    const low = id === featured ? croppedLow(row) : [];
    const high = id === featured ? croppedHigh(row) : [];
    return [...delta, ...low, ...high];
  });
  const yMin = 0;
  const yMax = Math.max(1, ...samples, 0) + 0.8;
  const x = (turn: number) =>
    margin.left + ((turn - xMin) / Math.max(1, xMax - xMin)) * innerW;
  const y = (value: number) =>
    margin.top + innerH - ((value - yMin) / Math.max(1e-6, yMax - yMin)) * innerH;

  const ticksY = yTicks(yMin, yMax);
  const ticksX = [16, 17, 18, 19, 20, 21];
  const featuredPresent = featured != null && rows.some((entry) => entry.id === featured);
  const labelItems = rows.map(({ id, row }) => {
    const delta = croppedDelta(row);
    return { key: id, y: y(delta[delta.length - 1] ?? 0) };
  });
  const labelY = spreadLabels(labelItems, margin.top + 8, margin.top + innerH - 4, 14);

  return (
    <div className="chart-plot" onMouseLeave={() => setHover(null)}>
      <svg
        className="chart-svg chart-svg-dark"
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="img"
      >
        <title>{`${axisLabel} from own-move ${CROP_FROM} to ${CROP_TO}`}</title>
        <defs>
          <clipPath id={clipId}>
            <rect x={margin.left} y={margin.top} width={innerW} height={innerH} />
          </clipPath>
        </defs>
        {ticksY.map((tick) => (
          <g key={`y-${tick}`}>
            <line
              className="chart-grid"
              x1={margin.left}
              x2={margin.left + innerW}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text className="chart-tick" x={margin.left - 8} y={y(tick) + 4} textAnchor="end">
              {tick}
            </text>
          </g>
        ))}
        {ticksX.map((tick) => (
          <text
            key={`x-${tick}`}
            className="chart-tick"
            x={x(tick)}
            y={height - 16}
            textAnchor="middle"
          >
            {tick}
          </text>
        ))}
        <line
          className="chart-zero"
          x1={margin.left}
          x2={margin.left + innerW}
          y1={y(0)}
          y2={y(0)}
        />
        <text className="chart-axis-label" x={WIDTH / 2} y={height - 2} textAnchor="middle">
          Own move
        </text>
        <text
          className="chart-axis-label"
          x={16}
          y={height / 2}
          textAnchor="middle"
          transform={`rotate(-90 16 ${height / 2})`}
        >
          {axisLabel}
        </text>
        <g clipPath={`url(#${clipId})`}>
          {rows.map(({ id, row }) => {
            if (id !== featured) return null;
            const turns = croppedTurns(row);
            const xs = turns.map((turn) => x(turn));
            return (
              <path
                key={`${id}-band`}
                className="chart-band"
                d={bandPath(xs, croppedHigh(row).map(y), croppedLow(row).map(y))}
                fill={MODEL_COLOR[id]}
              />
            );
          })}
          {rows.map(({ id, row }) => {
            const turns = croppedTurns(row);
            const delta = croppedDelta(row);
            const xs = turns.map((turn) => x(turn));
            const ys = delta.map(y);
            const isFeatured = id === featured;
            return (
              <g key={id} opacity={isFeatured || !featuredPresent ? 1 : 0.55}>
                <path
                  d={linePath(xs, ys)}
                  fill="none"
                  stroke={MODEL_COLOR[id]}
                  strokeWidth={isFeatured ? 2.7 : 1.55}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <circle
                  cx={xs[xs.length - 1]}
                  cy={ys[ys.length - 1]}
                  r={isFeatured ? 4.2 : 3}
                  fill={MODEL_COLOR[id]}
                />
              </g>
            );
          })}
        </g>
        {rows.map(({ id, row }) => {
          const delta = croppedDelta(row);
          const isFeatured = id === featured;
          return (
            <text
              key={`${id}-label`}
              className={isFeatured ? 'chart-endlabel featured' : 'chart-endlabel'}
              x={margin.left + innerW + 10}
              y={labelY.get(id) ?? y(delta[delta.length - 1] ?? 0)}
              style={{ fill: MODEL_COLOR[id] }}
            >
              {MODELS[id].shortName}
            </text>
          );
        })}
        {rows.map(({ id, row }) => {
          const turns = croppedTurns(row);
          const delta = croppedDelta(row);
          return turns.map((turn, index) => (
            <circle
              key={`${id}-${turn}`}
              className="chart-hit"
              cx={x(turn)}
              cy={y(delta[index] ?? 0)}
              r="10"
              pointerEvents="all"
              onMouseEnter={() =>
                setHover({
                  x: x(turn),
                  y: y(delta[index] ?? 0),
                  title: MODELS[id].displayName,
                  color: MODEL_COLOR[id],
                  lines: [`Own move ${turn}`, `${formatAdvantage(delta[index] ?? 0)} vs floor`],
                })
              }
            />
          ));
        })}
      </svg>
      <HoverCard hover={hover} width={WIDTH} height={height} />
    </div>
  );
}

export function GreedyParetoChart({
  ids,
  featured,
  lookup = trajectoryFor,
  axisLabel = 'Score Δ vs greedy',
  hoverVs = 'greedy',
  empty = '400-game vs-greedy trajectories are not on disk yet. Cost versus strength will plot once the first engine finishes.',
  title = 'Score delta versus greedy against milliseconds per move',
}: {
  ids: ModelId[];
  featured?: ModelId;
  lookup?: (id: ModelId) => GreedyTrajectoryResult | undefined;
  axisLabel?: string;
  hoverVs?: string;
  empty?: string;
  title?: string;
}) {
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const points = ids
    .map((id) => {
      const row = lookup(id);
      if (!row) return null;
      return {
        id,
        generation: MODELS[id].generation,
        label: MODELS[id].shortName,
        fullLabel: MODELS[id].displayName,
        ms: row.heroMsPerMove,
        delta: row.finalDelta,
        color: MODEL_COLOR[id],
      };
    })
    .filter(
      (
        point,
      ): point is {
        id: ModelId;
        generation: GenerationId;
        label: string;
        fullLabel: string;
        ms: number;
        delta: number;
        color: string;
      } => point != null,
    );

  if (points.length === 0) {
    return <ChartEmpty>{empty}</ChartEmpty>;
  }

  const height = PARETO_HEIGHT;
  const margin = { top: 22, right: 128, bottom: 48, left: 52 };
  const innerW = WIDTH - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const maxMs = Math.max(...points.map((point) => point.ms), 50);
  const xMin = 0;
  const xMax = maxMs * 1.06;
  const lowest = Math.min(0, ...points.map((point) => point.delta));
  const yMin = lowest < 0 ? lowest - 1.0 : 0;
  const yMax = Math.max(1, ...points.map((point) => point.delta), 0) + 1.0;
  const x = (ms: number) =>
    margin.left + ((xMax - ms) / Math.max(1e-6, xMax - xMin)) * innerW;
  const y = (value: number) =>
    margin.top + innerH - ((value - yMin) / Math.max(1e-6, yMax - yMin)) * innerH;

  // Derived from FAMILY_LABEL rather than hardcoded: a literal list here silently drops any
  // generation added later, which is exactly what happened when 3.5 and 3.6 shipped and every
  // other registry had been updated but this one had not.
  const families = (Object.keys(FAMILY_LABEL) as Array<keyof typeof FAMILY_LABEL>)
    .map((generation) => ({
      generation,
      points: points
        .filter((point) => point.generation === generation)
        .sort((a, b) => MODEL_ORDER.indexOf(a.id) - MODEL_ORDER.indexOf(b.id)),
    }))
    .filter((family) => family.points.length > 0);

  const labelItems = families.map((family) => {
    const peak = family.points.reduce((best, point) =>
      point.delta > best.delta ? point : best,
    );
    return { key: family.generation, y: y(peak.delta) };
  });
  const labelY = spreadLabels(labelItems, margin.top + 8, margin.top + innerH - 4, 16);

  // Same move-curve design at two effort levels; a dashed hop, not a new family polyline.
  const jumpFrom = points.find((point) => point.id === 'hanni-3-5-pro');
  const jumpTo = points.find((point) => point.id === 'hanni-3-6-pro-max');
  const jumpHighlighted =
    featured == null || featured === 'hanni-3-5-pro' || featured === 'hanni-3-6-pro-max';
  const featuredPresent = featured != null && points.some((point) => point.id === featured);

  return (
    <div className="chart-plot" onMouseLeave={() => setHover(null)}>
      <svg
        className="chart-svg chart-svg-dark"
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="img"
      >
        <title>{title}</title>
        {yTicks(yMin, yMax).map((tick) => (
          <g key={`py-${tick}`}>
            <line
              className="chart-grid"
              x1={margin.left}
              x2={margin.left + innerW}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text className="chart-tick" x={margin.left - 8} y={y(tick) + 4} textAnchor="end">
              {tick}
            </text>
          </g>
        ))}
        {msTicks(xMax).map((tick) => (
          <g key={`px-${tick}`}>
            <line
              className="chart-grid-v"
              x1={x(tick)}
              x2={x(tick)}
              y1={margin.top}
              y2={margin.top + innerH}
            />
            <text className="chart-tick" x={x(tick)} y={height - 18} textAnchor="middle">
              {Math.round(tick)}
            </text>
          </g>
        ))}
        <line
          className="chart-zero"
          x1={margin.left}
          x2={margin.left + innerW}
          y1={y(0)}
          y2={y(0)}
        />
        <text className="chart-axis-label" x={WIDTH / 2} y={height - 2} textAnchor="middle">
          Milliseconds per move (cheaper →)
        </text>
        <text
          className="chart-axis-label"
          x={16}
          y={height / 2}
          textAnchor="middle"
          transform={`rotate(-90 16 ${height / 2})`}
        >
          {axisLabel}
        </text>
        {families.map((family) => {
          const xs = family.points.map((point) => x(point.ms));
          const ys = family.points.map((point) => y(point.delta));
          const highlighted = featured
            ? family.points.some((point) => point.id === featured)
            : true;
          const featuredPresent = featured != null && points.some((point) => point.id === featured);
          const color = FAMILY_COLOR[family.generation];
          const cheap = family.points[0]!;
          return (
            <g key={family.generation} opacity={highlighted || !featuredPresent ? 1 : 0.38}>
              {family.points.length > 1 ? (
                <path
                  d={linePath(xs, ys)}
                  fill="none"
                  stroke={color}
                  strokeWidth={highlighted ? 2.2 : 1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ) : null}
              {family.points.map((point) => {
                const isFeatured = point.id === featured;
                const cx = x(point.ms);
                const cy = y(point.delta);
                return (
                  <g key={point.id}>
                    <circle
                      cx={cx}
                      cy={cy}
                      r={isFeatured ? 5.5 : 4}
                      fill={point.color}
                      stroke={isFeatured ? '#f4f0e8' : 'none'}
                      strokeWidth={isFeatured ? 1.4 : 0}
                    />
                    <circle
                      className="chart-hit"
                      cx={cx}
                      cy={cy}
                      r="14"
                      pointerEvents="all"
                      onMouseEnter={() =>
                        setHover({
                          x: cx,
                          y: cy,
                          title: point.fullLabel,
                          color: point.color,
                          lines: [
                            `${formatAdvantage(point.delta)} vs ${hoverVs}`,
                            `${Math.round(point.ms)} ms / move`,
                          ],
                        })
                      }
                    />
                  </g>
                );
              })}
              <text
                className={
                  featured && family.points.some((point) => point.id === featured)
                    ? 'chart-endlabel featured'
                    : 'chart-endlabel'
                }
                x={margin.left + innerW + 10}
                y={labelY.get(family.generation) ?? y(cheap.delta)}
                style={{ fill: color }}
              >
                {family.points.length === 1 ? cheap.fullLabel : FAMILY_LABEL[family.generation]}
              </text>
            </g>
          );
        })}
        {jumpFrom && jumpTo ? (
          <g pointerEvents="none">
            <line
              className="chart-jump"
              x1={x(jumpFrom.ms)}
              y1={y(jumpFrom.delta)}
              x2={x(jumpTo.ms)}
              y2={y(jumpTo.delta)}
              stroke={FAMILY_COLOR['3.6']}
              strokeWidth="1.8"
              strokeDasharray="5 4.5"
              strokeLinecap="round"
              opacity={jumpHighlighted || !featuredPresent ? 0.95 : 0.28}
            />
            {[jumpFrom, jumpTo].map((point) => {
              const isFeatured = point.id === featured;
              return (
                <circle
                  key={`${point.id}-jump-cap`}
                  cx={x(point.ms)}
                  cy={y(point.delta)}
                  r={isFeatured ? 5.5 : 4}
                  fill={point.color}
                  stroke={isFeatured ? '#f4f0e8' : 'none'}
                  strokeWidth={isFeatured ? 1.4 : 0}
                  opacity={jumpHighlighted || !featuredPresent ? 1 : 0.38}
                />
              );
            })}
          </g>
        ) : null}
      </svg>
      <HoverCard hover={hover} width={WIDTH} height={height} />
    </div>
  );
}

export function V31ParetoChart({
  ids,
  featured,
}: {
  ids: ModelId[];
  featured?: ModelId;
}) {
  return (
    <GreedyParetoChart
      ids={ids}
      featured={featured}
      lookup={v31TrajectoryFor}
      axisLabel="Score Δ vs Hanni 3.1"
      hoverVs="Hanni 3.1"
      title="Score delta versus Hanni 3.1 against milliseconds per move"
      empty="400-game vs-Hanni-3.1 trajectories are not on disk yet. Cost versus strength will plot once the first engine finishes."
    />
  );
}

/**
 * The same plot against a stronger reference.
 *
 * Against Hanni 3.1 the top of the ladder compresses — Hanni 4.1 Pro Max and Ultra both land near
 * +4.8 while being 1.49 apart head-to-head — because an engine already placing ~80 of 89 squares
 * has little margin left to win. Hanni 3.2 Pro leaves room, and it appears here at exactly zero so
 * its own cost is visible rather than inferred.
 */
export function V32ProParetoChart({
  ids,
  featured,
}: {
  ids: ModelId[];
  featured?: ModelId;
}) {
  return (
    <GreedyParetoChart
      ids={ids}
      featured={featured}
      lookup={v32ProTrajectoryFor}
      axisLabel="Score Δ vs Hanni 3.2 Pro"
      hoverVs="Hanni 3.2 Pro"
      title="Score delta versus Hanni 3.2 Pro against milliseconds per move"
      empty="400-game vs-Hanni-3.2-Pro trajectories are not on disk yet. Cost versus strength will plot once the first engine finishes."
    />
  );
}

export function TruncationChart() {
  const rows = [
    { plies: 12, advantage: 0, firstPlace: 25 },
    { plies: 18, advantage: 1.29, firstPlace: 34.3 },
    { plies: 24, advantage: 3.57, firstPlace: 45 },
    { plies: 36, advantage: 5.13, firstPlace: 50 },
    { plies: 48, advantage: 4.89, firstPlace: 46.9 },
    { plies: 84, advantage: 5.71, firstPlace: 52.1 },
  ];
  const width = 720;
  const height = 280;
  const left = 40;
  const right = 20;
  const top = 16;
  const bottom = 40;
  const innerW = width - left - right;
  const innerH = height - top - bottom;
  const maxY = 6;
  const x = (i: number) => left + (i / (rows.length - 1)) * innerW;
  const y = (v: number) => top + innerH - (v / maxY) * innerH;
  const line = rows.map((row, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(row.advantage)}`).join(' ');

  return (
    <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img">
      <title>Rollout truncation sweep</title>
      <path d={line} fill="none" stroke="#8b3fd1" strokeWidth="2.4" />
      {rows.map((row, i) => (
        <g key={row.plies}>
          <circle cx={x(i)} cy={y(row.advantage)} r="5" fill="#8b3fd1" />
          <text x={x(i)} y={height - 14} textAnchor="middle" fontSize="12">
            {row.plies}
          </text>
        </g>
      ))}
      <text x={width / 2} y={height - 1} textAnchor="middle" fontSize="12">
        Playout cutoff (plies)
      </text>
    </svg>
  );
}
