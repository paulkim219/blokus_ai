import type { MoveAnalysis } from '../engine/types';
import { PIECES } from '../engine/pieces';

interface ReviewPanelProps {
  analysis: MoveAnalysis | null;
}

export function ReviewPanel({ analysis }: ReviewPanelProps) {
  if (!analysis) {
    return (
      <div className="review-panel">
        <strong>Review</strong>
        <p className="status-line">Select a flagged move in the timeline to inspect the recommended alternative.</p>
      </div>
    );
  }

  const playedName = PIECES[analysis.played.pieceId].name;
  const bestName = analysis.best ? PIECES[analysis.best.pieceId].name : 'none';

  return (
    <div className="review-panel">
      <strong>
        Move #{analysis.moveIndex + 1}: {analysis.quality}
      </strong>
      <p>
        Played {playedName} at ({analysis.played.anchor.x}, {analysis.played.anchor.y})
        {analysis.best
          ? ` · Best was ${bestName} at (${analysis.best.anchor.x}, ${analysis.best.anchor.y})`
          : ''}
      </p>
      <ul>
        {analysis.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </div>
  );
}
