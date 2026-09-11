import { COLOR_LABELS, TURN_ORDER, type PlayerColor } from '../engine/types';
import type { WinOdds } from '../ai/winOdds';

const BAR_COLORS: Record<PlayerColor, string> = {
  blue: 'var(--blue)',
  yellow: 'var(--yellow)',
  purple: 'var(--purple)',
  green: 'var(--green)',
};

interface WinOddsBarProps {
  odds: WinOdds;
}

export function WinOddsBar({ odds }: WinOddsBarProps) {
  return (
    <div className="win-odds">
      <div className="win-odds-header">
        <span>Win odds</span>
        <span className="win-odds-meta">MCTS playout estimate</span>
      </div>

      <div className="win-odds-bar" role="img" aria-label="Win probability by player">
        {TURN_ORDER.map((color) => {
          const value = odds[color];
          if (value <= 0) {
            return null;
          }
          return (
            <div
              key={color}
              className={`win-odds-segment ${color}`}
              style={{
                width: `${value}%`,
                background: BAR_COLORS[color],
              }}
              title={`${COLOR_LABELS[color]}: ${value.toFixed(1)}%`}
            >
              {value >= 8 ? <span>{value.toFixed(0)}%</span> : null}
            </div>
          );
        })}
      </div>

      <div className="win-odds-legend">
        {TURN_ORDER.map((color) => (
          <span key={color} className="win-odds-legend-item">
            <span className="win-odds-swatch" style={{ background: BAR_COLORS[color] }} />
            {COLOR_LABELS[color]} {odds[color].toFixed(1)}%
          </span>
        ))}
      </div>
    </div>
  );
}
