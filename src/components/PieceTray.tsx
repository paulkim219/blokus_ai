import { PIECES } from '../engine/pieces';
import type { Cell, PlayerColor } from '../engine/types';
import { COLOR_LABELS } from '../engine/types';
import { PieceManipulator } from './PieceManipulator';

interface PieceTrayProps {
  color: PlayerColor;
  remainingPieceIds: number[];
  isActive: boolean;
  isUser: boolean;
  selectedPieceId: number | null;
  manipulator?: {
    cells: Cell[];
    pin: Cell;
  } | null;
  playerName?: string;
  onSelectPiece: (pieceId: number) => void;
  onPass?: () => void;
  onSetPin?: (cell: Cell) => void;
  onFlip?: () => void;
  onRotateCw?: () => void;
  onRotateCcw?: () => void;
  onCloseManipulator?: () => void;
}

const COLOR_MAP: Record<PlayerColor, string> = {
  blue: 'var(--blue)',
  yellow: 'var(--yellow)',
  purple: 'var(--purple)',
  green: 'var(--green)',
};

const HEADER_BG: Record<PlayerColor, string> = {
  blue: 'var(--blue)',
  yellow: 'var(--yellow)',
  purple: 'var(--purple)',
  green: 'var(--green)',
};

function PiecePreview({
  pieceId,
  color,
}: {
  pieceId: number;
  color: PlayerColor;
}) {
  const cells = PIECES[pieceId].cells;
  const maxX = Math.max(...cells.map((cell) => cell.x));
  const maxY = Math.max(...cells.map((cell) => cell.y));
  const occupied = new Set(cells.map((cell) => `${cell.x},${cell.y}`));

  return (
    <div
      className="piece-preview"
      style={{ gridTemplateColumns: `repeat(${maxX + 1}, 14px)` }}
    >
      {Array.from({ length: maxY + 1 }, (_, y) =>
        Array.from({ length: maxX + 1 }, (_, x) => {
          const filled = occupied.has(`${x},${y}`);
          return (
            <span
              key={`${pieceId}-${x}-${y}`}
              className="piece-cell"
              style={{
                visibility: filled ? 'visible' : 'hidden',
                background: COLOR_MAP[color],
              }}
            />
          );
        }),
      )}
    </div>
  );
}

export function PieceTray({
  color,
  remainingPieceIds,
  isActive,
  isUser,
  selectedPieceId,
  manipulator,
  playerName,
  onSelectPiece,
  onPass,
  onSetPin,
  onFlip,
  onRotateCw,
  onRotateCcw,
  onCloseManipulator,
}: PieceTrayProps) {
  const showManipulator = Boolean(isActive && selectedPieceId !== null && manipulator);

  return (
    <div
      className={`tray-panel ${isActive ? 'active' : ''} ${showManipulator ? 'manipulating' : ''}`}
      style={{ borderColor: COLOR_MAP[color] }}
    >
      <div className="tray-header" style={{ background: HEADER_BG[color] }}>
        <span className="player-badge light">
          <span className="color-dot light" />
          {isUser ? playerName || COLOR_LABELS[color] : COLOR_LABELS[color]}
        </span>
        {isUser ? <span className="you-tag light">You</span> : null}
      </div>

      {showManipulator && manipulator && onSetPin && onFlip && onRotateCw && onRotateCcw && onCloseManipulator ? (
        <PieceManipulator
          color={color}
          cells={manipulator.cells}
          pin={manipulator.pin}
          onSetPin={onSetPin}
          onFlip={onFlip}
          onRotateCw={onRotateCw}
          onRotateCcw={onRotateCcw}
          onClose={onCloseManipulator}
        />
      ) : (
        <>
          <div className="tray-pieces">
            {PIECES.map((piece) => {
              const remaining = remainingPieceIds.includes(piece.id);
              if (!remaining) {
                return null;
              }
              const selected = selectedPieceId === piece.id;
              return (
                <button
                  key={piece.id}
                  type="button"
                  className={`piece-chip ${selected ? 'selected' : ''} ${isActive ? '' : 'inactive'}`}
                  disabled={!isActive}
                  onClick={() => onSelectPiece(piece.id)}
                  title={piece.name}
                >
                  <PiecePreview pieceId={piece.id} color={color} />
                </button>
              );
            })}
          </div>

          {isActive ? (
            <div className="tray-footer">
              <button type="button" className="pass-button" onClick={onPass}>
                Pass...
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
