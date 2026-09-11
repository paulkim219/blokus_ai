import type { GameMove, MoveAnalysis } from '../engine/types';
import { PIECES } from '../engine/pieces';
import { getMoveLabel } from '../store/gameStore';

interface TimelineProps {
  moves: GameMove[];
  analyses: MoveAnalysis[];
  activeIndex: number | null;
  userColor: string;
  onSelect: (moveIndex: number) => void;
}

export function Timeline({ moves, analyses, activeIndex, onSelect }: TimelineProps) {
  return (
    <div className="timeline">
      {moves.map((move, index) => {
        const analysis = analyses.find((entry) => entry.moveIndex === index);
        const flagged =
          analysis && (analysis.quality === 'blunder' || analysis.quality === 'inaccuracy');
        const label =
          move.type === 'place'
            ? `${move.color} ${PIECES[move.pieceId].name}`
            : `${move.color} pass`;

        return (
          <button
            key={index}
            type="button"
            className={`timeline-node ${activeIndex === index ? 'active' : ''} ${flagged ? 'flagged' : ''}`}
            onClick={() => onSelect(index)}
            title={getMoveLabel(move, index)}
          >
            <div>#{index + 1}</div>
            <div>{label}</div>
            {analysis && flagged ? <div>{analysis.quality}</div> : null}
          </button>
        );
      })}
    </div>
  );
}
