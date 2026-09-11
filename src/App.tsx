import { useEffect, useMemo, useState } from 'react';
import { SetupModal } from './components/SetupModal';
import { Board } from './components/Board';
import { PieceTray } from './components/PieceTray';
import { GameControls, Scoreboard } from './components/GameControls';
import { MoveQualityChip } from './components/MoveQualityChip';
import { Timeline } from './components/Timeline';
import { ReviewPanel } from './components/ReviewPanel';
import { SyncStatus } from './components/SyncStatus';
import { getSelectionShape, useGameStore } from './store/gameStore';
import type { PlayerColor } from './engine/types';
import { COLOR_LABELS } from './engine/types';
import { PIECES } from './engine/pieces';
import { formatProgressLabel } from './ai/progress';
import { WinOddsBar } from './components/WinOddsBar';
import { requestSyncSnapshot, subscribeSyncMessages } from './sync/listen';

function App() {
  const {
    phase,
    config,
    state,
    suggestionsEnabled,
    suggestionsForAll,
    algoVersion,
    selection,
    analyzing,
    searchProgress,
    suggestion,
    suggestionTip,
    liveFeedback,
    moveAnalyses,
    reviewIndex,
    fullState,
    reviewAnalysis,
    startSession,
    newGame,
    setSuggestionsEnabled,
    setSuggestionsForAll,
    setAlgoVersion,
    selectPiece,
    clearSelection,
    rotateSelection,
    flipSelection,
    setPin,
    placeAt,
    pass,
    undo,
    endGame,
    jumpToMove,
    loadSavedSession,
    refreshSuggestion,
    refreshPonder,
    refreshWinOdds,
    winOdds,
    liveSyncEnabled,
    syncStatus,
    setLiveSyncEnabled,
    noteSyncConnection,
    applySyncedBoard,
  } = useGameStore();

  const [hoverCell, setHoverCell] = useState<{ x: number; y: number } | null>(null);

  const shape = useMemo(() => getSelectionShape(selection), [selection]);

  useEffect(() => {
    loadSavedSession();
  }, [loadSavedSession]);

  useEffect(() => {
    if (!liveSyncEnabled) {
      return;
    }
    const unsubscribe = subscribeSyncMessages((payload) => {
      if (payload.type === 'ping' || payload.type === 'hello') {
        noteSyncConnection(
          payload.source,
          'detail' in payload ? payload.detail : undefined,
        );
        return;
      }
      if (payload.type === 'board') {
        void applySyncedBoard(payload.board, payload.currentTurn, payload.source, payload.passColor);
      }
    });
    // Ask the extension again shortly after enable in case the game tab was slow to inject.
    const retry = window.setTimeout(() => requestSyncSnapshot(), 800);
    const retry2 = window.setTimeout(() => requestSyncSnapshot(), 2000);
    return () => {
      unsubscribe();
      window.clearTimeout(retry);
      window.clearTimeout(retry2);
    };
  }, [liveSyncEnabled, noteSyncConnection, applySyncedBoard]);

  useEffect(() => {
    if (phase === 'playing' || phase === 'review') {
      void refreshWinOdds();
    }
  }, [phase, refreshWinOdds, state.moveHistory.length, state.finished]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'r') {
        rotateSelection(1);
      }
      if (event.key.toLowerCase() === 'f') {
        flipSelection();
      }
      if (event.key === 'Escape') {
        clearSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearSelection, flipSelection, rotateSelection]);

  useEffect(() => {
    if (!suggestionsEnabled || !config || state.finished) {
      return;
    }
    if (suggestionsForAll || state.currentTurn === config.userColor) {
      void refreshSuggestion();
    } else {
      void refreshPonder();
    }
  }, [
    config,
    refreshSuggestion,
    refreshPonder,
    state.currentTurn,
    state.finished,
    suggestionsEnabled,
    suggestionsForAll,
    state.moveHistory.length,
  ]);

  if (phase === 'setup' || !config) {
    return <SetupModal onStart={startSession} />;
  }

  const trays: Array<{ color: PlayerColor; className: string }> = [
    { color: 'blue', className: 'tray-top-left' },
    { color: 'yellow', className: 'tray-top-right' },
    { color: 'green', className: 'tray-bottom-left' },
    { color: 'purple', className: 'tray-bottom-right' },
  ];

  const isUserTurn = state.currentTurn === config.userColor && !state.finished;
  const suggestionsActiveForTurn =
    suggestionsEnabled && !state.finished && (suggestionsForAll || isUserTurn);
  const displaySuggestion = suggestionsActiveForTurn ? suggestion : null;
  const showSuggestionProgress = suggestionsActiveForTurn && analyzing;
  const suggestionSeat = suggestionsForAll ? state.currentTurn : config.userColor;
  const suggestionSeatLabel = COLOR_LABELS[suggestionSeat];

  const timelineState = fullState ?? state;
  const reviewSuggestion =
    phase === 'review' && reviewAnalysis?.best ? reviewAnalysis.best : displaySuggestion;

  return (
    <div className="app-shell">
      <div className="game-layout">
        {trays.map(({ color, className }) => {
          const isActive = state.currentTurn === color && !state.finished;
          const showManip =
            isActive && selection.pieceId !== null && shape !== null
              ? { cells: shape.cells, pin: shape.pin }
              : null;

          return (
            <div key={color} className={`tray-slot ${className}`}>
              <PieceTray
                color={color}
                remainingPieceIds={state.remainingPieces[color]}
                isActive={isActive}
                isUser={config.userColor === color}
                playerName={config.userName}
                selectedPieceId={isActive ? selection.pieceId : null}
                manipulator={showManip}
                onSelectPiece={(pieceId) => {
                  if (isActive) {
                    selectPiece(pieceId);
                  }
                }}
                onPass={() => {
                  void pass();
                }}
                onSetPin={setPin}
                onFlip={flipSelection}
                onRotateCw={() => rotateSelection(1)}
                onRotateCcw={() => rotateSelection(-1)}
                onCloseManipulator={clearSelection}
              />
            </div>
          );
        })}

        <div className="board-area">
          <div className="board-wrap">
            {liveFeedback?.visible ? (
              <MoveQualityChip label={liveFeedback.visible} />
            ) : null}
            <Board
              state={state}
              selectedPieceId={selection.pieceId}
              orientationIndex={shape?.orientationIndex ?? 0}
              piecePin={shape?.pin ?? null}
              hoverCell={hoverCell}
              suggestion={reviewSuggestion}
              onHover={setHoverCell}
              onPlace={(x, y) => {
                void placeAt(x, y);
              }}
            />
          </div>
          {suggestionsEnabled ? (
            <div className={`suggestion-banner ${showSuggestionProgress ? 'pending' : ''}`}>
              {showSuggestionProgress && searchProgress ? (
                <div className="search-progress">
                  <div className="search-progress-row">
                    <span>
                      <span className="analyzing-dot" />
                      {formatProgressLabel(searchProgress)}
                    </span>
                    <span className="search-progress-meta">
                      {(searchProgress.elapsedMs / 1000).toFixed(1)}s /{' '}
                      {(searchProgress.timeLimitMs / 1000).toFixed(1)}s
                    </span>
                  </div>
                  <div className="search-progress-bar">
                    <div
                      className="search-progress-fill"
                      style={{ width: `${Math.max(4, searchProgress.percent)}%` }}
                    />
                  </div>
                  {searchProgress.currentBestLabel ? (
                    <div className="search-progress-best">
                      Current best: {searchProgress.currentBestLabel}
                    </div>
                  ) : null}
                </div>
              ) : showSuggestionProgress ? (
                <>
                  <span className="analyzing-dot" />
                  Preparing search for {suggestionSeatLabel}…
                </>
              ) : !suggestionsActiveForTurn ? (
                <>Suggestions on — AI help appears on your ({COLOR_LABELS[config.userColor]}) turns.</>
              ) : displaySuggestion ? (
                <>
                  Suggested for {suggestionsForAll ? suggestionSeatLabel : `you (${suggestionSeatLabel})`}:{' '}
                  {PIECES[displaySuggestion.pieceId].name} at (
                  {displaySuggestion.anchor.x}, {displaySuggestion.anchor.y})
                  {suggestionTip ? ` — ${suggestionTip}` : ''}
                </>
              ) : (
                <>No suggestion available for this position.</>
              )}
            </div>
          ) : null}
        </div>

        <div className="controls-bar">
          <GameControls
            state={state}
            config={config}
            suggestionsEnabled={suggestionsEnabled}
            suggestionsForAll={suggestionsForAll}
            algoVersion={algoVersion}
            analyzing={analyzing}
            onToggleSuggestions={(enabled) => {
              void setSuggestionsEnabled(enabled);
            }}
            onToggleSuggestionsForAll={(forAll) => {
              void setSuggestionsForAll(forAll);
            }}
            onAlgoVersionChange={(version) => {
              void setAlgoVersion(version);
            }}
            onUndo={undo}
            onEndGame={() => {
              void endGame();
            }}
            onNewGame={() => {
              if (
                state.moveHistory.length === 0 ||
                window.confirm('Start a new game? Current progress will be cleared.')
              ) {
                newGame();
              }
            }}
          />
        </div>

        <div className="odds-bar-slot">
          <WinOddsBar odds={winOdds} />
          <SyncStatus
            sync={syncStatus}
            enabled={liveSyncEnabled}
            onToggle={setLiveSyncEnabled}
          />
        </div>
      </div>

      {phase === 'review' || state.finished ? (
        <section className="review-section">
          <h2>Post-game review</h2>
          <Scoreboard state={timelineState} />
          <Timeline
            moves={timelineState.moveHistory}
            analyses={moveAnalyses}
            activeIndex={reviewIndex}
            userColor={config.userColor}
            onSelect={jumpToMove}
          />
          <ReviewPanel analysis={reviewAnalysis} />
        </section>
      ) : null}
    </div>
  );
}

export default App;
