import type { Cell, PlayerColor } from '../engine/types';

const COLOR_MAP: Record<PlayerColor, string> = {
  blue: 'var(--blue)',
  yellow: 'var(--yellow)',
  purple: 'var(--purple)',
  green: 'var(--green)',
};

interface PieceManipulatorProps {
  color: PlayerColor;
  cells: Cell[];
  pin: Cell;
  onSetPin: (cell: Cell) => void;
  onFlip: () => void;
  onRotateCw: () => void;
  onRotateCcw: () => void;
  onClose: () => void;
}

export function PieceManipulator({
  color,
  cells,
  pin,
  onSetPin,
  onFlip,
  onRotateCw,
  onRotateCcw,
  onClose,
}: PieceManipulatorProps) {
  const maxX = Math.max(...cells.map((cell) => cell.x));
  const maxY = Math.max(...cells.map((cell) => cell.y));
  const occupied = new Set(cells.map((cell) => `${cell.x},${cell.y}`));

  return (
    <div className="manipulator-inline">
      <div className="manipulator-actions">
        <button type="button" className="manip-btn flip" onClick={onFlip} title="Flip" aria-label="Flip">
          ⇆
        </button>
        <button
          type="button"
          className="manip-btn rotate"
          onClick={onRotateCcw}
          title="Rotate counter-clockwise"
          aria-label="Rotate counter-clockwise"
        >
          ↺
        </button>
        <button
          type="button"
          className="manip-btn rotate"
          onClick={onRotateCw}
          title="Rotate clockwise"
          aria-label="Rotate clockwise"
        >
          ↻
        </button>
        <button type="button" className="manip-btn close" onClick={onClose} title="Close" aria-label="Close">
          ✕
        </button>
      </div>

      <div
        className="manipulator-grid"
        style={{ gridTemplateColumns: `repeat(${maxX + 1}, 26px)` }}
      >
        {Array.from({ length: maxY + 1 }, (_, y) =>
          Array.from({ length: maxX + 1 }, (_, x) => {
            const filled = occupied.has(`${x},${y}`);
            if (!filled) {
              return <span key={`${x}-${y}`} className="manip-cell empty" />;
            }
            const isPin = pin.x === x && pin.y === y;
            return (
              <button
                key={`${x}-${y}`}
                type="button"
                className={`manip-cell filled ${isPin ? 'pinned' : ''}`}
                style={{ background: COLOR_MAP[color] }}
                onClick={() => onSetPin({ x, y })}
              >
                {isPin ? <span className="pin-marker" /> : null}
              </button>
            );
          }),
        )}
      </div>

      <p className="manipulator-hint">Set the pin, then click that square on the board.</p>
    </div>
  );
}
