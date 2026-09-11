import { useMemo } from 'react';
import { BOARD_SIZE, START_CORNERS } from '../engine/types';
import type { Cell, PlaceMove, PlayerColor } from '../engine/types';
import { getAbsoluteCellsWithPin } from '../engine/pieces';
import { isLegalPlacementWithPin } from '../engine/game';
import type { GameState } from '../engine/types';

interface BoardProps {
  state: GameState;
  selectedPieceId: number | null;
  orientationIndex: number;
  piecePin: Cell | null;
  hoverCell: Cell | null;
  suggestion: PlaceMove | null;
  onHover: (cell: Cell | null) => void;
  onPlace: (x: number, y: number) => void;
}

const CORNER_COLORS: Record<PlayerColor, string> = {
  blue: 'var(--blue)',
  yellow: 'var(--yellow)',
  purple: 'var(--purple)',
  green: 'var(--green)',
};

export function Board({
  state,
  selectedPieceId,
  orientationIndex,
  piecePin,
  hoverCell,
  suggestion,
  onHover,
  onPlace,
}: BoardProps) {
  const ghostCells = useMemo(() => {
    if (!hoverCell || selectedPieceId === null || !piecePin) {
      return new Set<string>();
    }
    const cells = getAbsoluteCellsWithPin(
      selectedPieceId,
      orientationIndex,
      hoverCell,
      piecePin,
    );
    return new Set(cells.map((cell) => `${cell.x},${cell.y}`));
  }, [hoverCell, orientationIndex, piecePin, selectedPieceId]);

  const ghostLegal =
    hoverCell &&
    selectedPieceId !== null &&
    piecePin !== null &&
    !!isLegalPlacementWithPin(
      state,
      state.currentTurn,
      selectedPieceId,
      orientationIndex,
      hoverCell,
      piecePin,
    );

  const suggestionCells = useMemo(() => {
    if (!suggestion) {
      return new Set<string>();
    }
    return new Set(suggestion.absoluteCells.map((cell) => `${cell.x},${cell.y}`));
  }, [suggestion]);

  return (
    <div className="board-frame">
      <div className="board-grid">
        {Array.from({ length: BOARD_SIZE }, (_, y) =>
          Array.from({ length: BOARD_SIZE }, (_, x) => {
            const occupant = state.board[y][x];
            const key = `${x},${y}`;
            const isGhost = ghostCells.has(key);
            const isSuggested = suggestionCells.has(key);
            const isHoverPin =
              !!hoverCell &&
              hoverCell.x === x &&
              hoverCell.y === y &&
              selectedPieceId !== null;
            const cornerColor = Object.entries(START_CORNERS).find(
              ([, corner]) => corner.x === x && corner.y === y,
            )?.[0] as PlayerColor | undefined;

            let className = 'board-cell';
            if (occupant) {
              className += ` occupied ${occupant} placed`;
            }
            if (isGhost) {
              className += ` ghost ${ghostLegal ? '' : 'invalid'}`;
            }
            if (isSuggested && !occupant) {
              className += ' suggested';
            }

            return (
              <button
                key={key}
                type="button"
                className={className}
                style={
                  isGhost
                    ? { background: CORNER_COLORS[state.currentTurn] }
                    : isSuggested
                      ? {
                          background: CORNER_COLORS[
                            suggestion?.color ?? state.currentTurn
                          ],
                          opacity: 0.55,
                        }
                      : undefined
                }
                onMouseEnter={() => onHover({ x, y })}
                onMouseLeave={() => onHover(null)}
                onClick={() => onPlace(x, y)}
              >
                {cornerColor && !occupant ? (
                  <span
                    className="corner-marker"
                    style={{ background: CORNER_COLORS[cornerColor] }}
                  />
                ) : null}
                {isHoverPin ? (
                  <span
                    className="board-pin"
                    style={{ color: CORNER_COLORS[state.currentTurn] }}
                  />
                ) : null}
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}
