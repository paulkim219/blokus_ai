import { calculateScores } from '../engine/game';
import type { GameState, SessionConfig } from '../engine/types';
import { COLOR_LABELS } from '../engine/types';
import type { UiAlgoVersion } from '../ai/algoVersions';
import { SuggestionToggle } from './SuggestionToggle';
import { AlgoVersionSelect } from './AlgoVersionSelect';

interface GameControlsProps {
  state: GameState;
  config: SessionConfig;
  suggestionsEnabled: boolean;
  suggestionsForAll: boolean;
  algoVersion: string;
  analyzing: boolean;
  onToggleSuggestions: (enabled: boolean) => void;
  onToggleSuggestionsForAll: (forAll: boolean) => void;
  onAlgoVersionChange: (version: UiAlgoVersion) => void;
  onUndo: () => void;
  onEndGame: () => void;
  onNewGame: () => void;
}

export function GameControls({
  state,
  config,
  suggestionsEnabled,
  suggestionsForAll,
  algoVersion,
  analyzing,
  onToggleSuggestions,
  onToggleSuggestionsForAll,
  onAlgoVersionChange,
  onUndo,
  onEndGame,
  onNewGame,
}: GameControlsProps) {
  const activeLabel = COLOR_LABELS[state.currentTurn];
  const isUserTurn = state.currentTurn === config.userColor;
  const showAnalyzing = analyzing && (suggestionsForAll || isUserTurn);

  return (
    <>
      <div className="controls-group">
        <SuggestionToggle
          enabled={suggestionsEnabled}
          forAll={suggestionsForAll}
          onChangeEnabled={onToggleSuggestions}
          onChangeForAll={onToggleSuggestionsForAll}
        />
        <AlgoVersionSelect value={algoVersion} onChange={onAlgoVersionChange} />
        <button
          type="button"
          className="control-button"
          onClick={onUndo}
          disabled={state.moveHistory.length === 0}
        >
          Undo
        </button>
        <button type="button" className="control-button" onClick={onEndGame}>
          End game
        </button>
        <button type="button" className="control-button primary" onClick={onNewGame}>
          New game
        </button>
      </div>

      <div className="status-line">
        {showAnalyzing ? <span className="analyzing-dot" /> : null}
        Turn: {activeLabel}
        {isUserTurn ? ' · your move' : ''}
        {state.finished ? ' · game finished' : ''}
        <span className="turn-order-hint"> · order: Blue → Green → Purple → Yellow</span>
        <span className="turn-order-hint">
          {' '}
          · opening: {state.openingMode === 'anywhere' ? 'Anywhere' : 'Corner'}
        </span>
      </div>
    </>
  );
}

export function Scoreboard({ state }: { state: GameState }) {
  const scores = calculateScores(state);
  return (
    <div className="scoreboard">
      {scores.map((entry) => (
        <div key={entry.color} className="score-card">
          <strong>{COLOR_LABELS[entry.color]}</strong>
          <div>{entry.score} pts</div>
          <div className="status-line">{entry.remainingSquares} squares left</div>
        </div>
      ))}
    </div>
  );
}
