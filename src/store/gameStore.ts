import { create } from 'zustand';
import {
  applyMove,
  createInitialState,
  getStateAtMoveIndex,
  isLegalPlacementWithPin,
  passTurn,
  undoMove,
} from '../engine/game';
import type {
  Cell,
  GameMove,
  GameState,
  MoveAnalysis,
  MoveQuality,
  PlaceMove,
  PlayerColor,
  SavedSession,
  SessionConfig,
} from '../engine/types';
import { PLAYER_COLORS } from '../engine/types';
import {
  requestBatchAnalysis,
  requestPlayedMoveAnalysis,
  requestPonder,
  requestSuggestion,
  requestWinOdds,
} from '../worker/aiClient';
import { getShapeFromTransform, PIECES } from '../engine/pieces';
import { visibleQuality } from '../ai/quality';
import type { SearchProgress } from '../ai/progress';
import { EMPTY_WIN_ODDS, smoothWinOdds, type WinOdds } from '../ai/winOdds';
import {
  DEFAULT_UI_ALGO_VERSION,
  UI_SEARCH_ITERATIONS,
  isUiAlgoVersion,
  type UiAlgoVersion,
} from '../ai/algoVersions';
import { applyExternalBoard } from '../sync/boardDiff';
import { remapBoardColorsByCorners } from '../sync/remapColors';
import type { ExternalBoard, SyncStatusState } from '../sync/types';

const STORAGE_KEY = 'blokee-session-v1';

const EMPTY_SYNC_STATUS: SyncStatusState = {
  status: 'idle',
  detail: '',
  lastTs: null,
  lastSource: null,
  appliedMoves: 0,
};

export interface UiSelection {
  pieceId: number | null;
  rotations: number;
  flipped: boolean;
  /** Pin in base (untransformed) piece coordinates */
  basePin: Cell;
}

interface LiveFeedback {
  moveIndex: number;
  quality: MoveQuality;
  visible: 'best' | 'blunder' | null;
}

const EMPTY_SELECTION: UiSelection = {
  pieceId: null,
  rotations: 0,
  flipped: false,
  basePin: { x: 0, y: 0 },
};

interface GameStore {
  phase: 'setup' | 'playing' | 'review';
  config: SessionConfig | null;
  state: GameState;
  fullState: GameState | null;
  suggestionsEnabled: boolean;
  suggestionsForAll: boolean;
  algoVersion: UiAlgoVersion;
  selection: UiSelection;
  analyzing: boolean;
  searchProgress: SearchProgress | null;
  suggestion: PlaceMove | null;
  suggestionTip: string;
  liveFeedback: LiveFeedback | null;
  moveAnalyses: MoveAnalysis[];
  reviewIndex: number | null;
  reviewAnalysis: MoveAnalysis | null;
  winOdds: WinOdds;
  oddsUpdating: boolean;
  oddsSimulationsDone: number;
  oddsSimulationsTotal: number;
  oddsRequestId: number;
  liveSyncEnabled: boolean;
  syncStatus: SyncStatusState;
  startSession: (config: SessionConfig) => void;
  newGame: () => void;
  setSuggestionsEnabled: (enabled: boolean) => Promise<void>;
  setSuggestionsForAll: (forAll: boolean) => Promise<void>;
  setAlgoVersion: (version: UiAlgoVersion) => Promise<void>;
  setLiveSyncEnabled: (enabled: boolean) => void;
  noteSyncConnection: (source?: string, detail?: string) => void;
  applySyncedBoard: (
    board: ExternalBoard,
    currentTurn?: PlayerColor,
    source?: string,
    passColor?: PlayerColor,
  ) => Promise<void>;
  selectPiece: (pieceId: number | null) => void;
  clearSelection: () => void;
  rotateSelection: (direction?: 1 | -1) => void;
  flipSelection: () => void;
  setPin: (pinInCurrentShape: Cell) => void;
  placeAt: (x: number, y: number) => Promise<void>;
  pass: () => Promise<void>;
  undo: () => void;
  endGame: () => Promise<void>;
  jumpToMove: (moveIndex: number) => void;
  loadSavedSession: () => void;
  persistSession: () => void;
  refreshSuggestion: () => Promise<void>;
  refreshPonder: () => Promise<void>;
  refreshWinOdds: () => Promise<void>;
}

function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as SavedSession;
  } catch {
    return null;
  }
}

function saveSession(session: SavedSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function getSelectionShape(selection: UiSelection): {
  cells: Cell[];
  orientationIndex: number;
  pin: Cell;
} | null {
  if (selection.pieceId === null) {
    return null;
  }
  const shape = getShapeFromTransform(
    selection.pieceId,
    selection.rotations,
    selection.flipped,
  );
  return {
    cells: shape.cells,
    orientationIndex: shape.orientationIndex,
    pin: shape.pinFor(selection.basePin),
  };
}

export const useGameStore = create<GameStore>((set, get) => ({
  phase: 'setup',
  config: null,
  state: createInitialState(),
  fullState: null,
  suggestionsEnabled: false,
  suggestionsForAll: false,
  algoVersion: DEFAULT_UI_ALGO_VERSION,
  selection: EMPTY_SELECTION,
  analyzing: false,
  searchProgress: null,
  suggestion: null,
  suggestionTip: '',
  liveFeedback: null,
  moveAnalyses: [],
  reviewIndex: null,
  reviewAnalysis: null,
  winOdds: { ...EMPTY_WIN_ODDS },
  oddsUpdating: false,
  oddsSimulationsDone: 0,
  oddsSimulationsTotal: 0,
  oddsRequestId: 0,
  liveSyncEnabled: false,
  syncStatus: { ...EMPTY_SYNC_STATUS },

  startSession: (config) => {
    set({
      phase: 'playing',
      config,
      state: createInitialState(config.openingMode),
      fullState: null,
      suggestionsEnabled: false,
      suggestionsForAll: false,
      selection: EMPTY_SELECTION,
      analyzing: false,
      searchProgress: null,
      suggestion: null,
      suggestionTip: '',
      liveFeedback: null,
      moveAnalyses: [],
      reviewIndex: null,
      reviewAnalysis: null,
      winOdds: { ...EMPTY_WIN_ODDS },
      oddsUpdating: false,
      oddsSimulationsDone: 0,
      oddsSimulationsTotal: 0,
      liveSyncEnabled: false,
      syncStatus: { ...EMPTY_SYNC_STATUS },
    });
    get().persistSession();
  },

  newGame: () => {
    localStorage.removeItem(STORAGE_KEY);
    set({
      phase: 'setup',
      config: null,
      state: createInitialState(),
      fullState: null,
      suggestionsEnabled: false,
      suggestionsForAll: false,
      selection: EMPTY_SELECTION,
      analyzing: false,
      searchProgress: null,
      suggestion: null,
      suggestionTip: '',
      liveFeedback: null,
      moveAnalyses: [],
      reviewIndex: null,
      reviewAnalysis: null,
      winOdds: { ...EMPTY_WIN_ODDS },
      oddsUpdating: false,
      oddsSimulationsDone: 0,
      oddsSimulationsTotal: 0,
      liveSyncEnabled: false,
      syncStatus: { ...EMPTY_SYNC_STATUS },
    });
  },

  setLiveSyncEnabled: (enabled) => {
    set({
      liveSyncEnabled: enabled,
      syncStatus: enabled
        ? {
            status: 'idle',
            detail: 'Connecting… requesting live board snapshot',
            lastTs: Date.now(),
            lastSource: null,
            appliedMoves: 0,
          }
        : { ...EMPTY_SYNC_STATUS },
    });
  },

  noteSyncConnection: (source, detail) => {
    if (!get().liveSyncEnabled) {
      return;
    }
    const current = get().syncStatus;
    // Don't clobber a successful mirror status with a generic ping.
    if (current.status === 'applied' || current.status === 'synced' || current.status === 'pass') {
      set({
        syncStatus: {
          ...current,
          lastTs: Date.now(),
          lastSource: source ?? current.lastSource,
        },
      });
      return;
    }
    set({
      syncStatus: {
        ...current,
        status: 'connected',
        detail:
          detail ||
          'Extension connected — waiting for board data from the game tab',
        lastTs: Date.now(),
        lastSource: source ?? current.lastSource,
      },
    });
  },

  applySyncedBoard: async (board, currentTurn, source, passColor) => {
    const { state, liveSyncEnabled, phase, config } = get();
    if (!liveSyncEnabled || !config || phase === 'setup') {
      return;
    }

    const remapped = remapBoardColorsByCorners(board);
    const beforeLen = state.moveHistory.length;
    const beforeTurn = state.currentTurn;
    // Recover if a prior sync wrongly marked the game finished.
    const baseState = state.finished ? { ...state, finished: false } : state;
    const result = applyExternalBoard(baseState, remapped, currentTurn, passColor);
    // Live sync never auto-ends from heuristics — only after four consecutive passes.
    const nextState = {
      ...result.state,
      finished: result.state.consecutivePasses >= PLAYER_COLORS.length,
      ...(passColor ? { currentTurn: passColor } : {}),
    };

    if (
      result.state === state &&
      result.status === 'synced' &&
      nextState.currentTurn === beforeTurn &&
      !state.finished
    ) {
      set({
        syncStatus: {
          status: 'synced',
          detail: result.detail,
          lastTs: Date.now(),
          lastSource: source ?? get().syncStatus.lastSource,
          appliedMoves: get().syncStatus.appliedMoves,
        },
      });
      return;
    }

    if (result.status === 'mismatch' || result.status === 'error') {
      set({
        syncStatus: {
          status: result.status,
          detail: result.detail,
          lastTs: Date.now(),
          lastSource: source ?? get().syncStatus.lastSource,
          appliedMoves: get().syncStatus.appliedMoves,
        },
      });
      return;
    }

    set({
      state: nextState,
      phase: nextState.finished ? 'review' : 'playing',
      fullState: nextState.finished ? nextState : null,
      selection: EMPTY_SELECTION,
      suggestion: null,
      suggestionTip: '',
      liveFeedback: null,
      syncStatus: {
        status: result.status,
        detail: result.detail,
        lastTs: Date.now(),
        lastSource: source ?? get().syncStatus.lastSource,
        appliedMoves: get().syncStatus.appliedMoves + result.applied,
      },
    });
    get().persistSession();

    if (
      nextState.moveHistory.length !== beforeLen ||
      nextState.currentTurn !== beforeTurn ||
      state.finished
    ) {
      void get().refreshWinOdds();
      if (get().suggestionsEnabled && !nextState.finished) {
        if (get().suggestionsForAll || nextState.currentTurn === config.userColor) {
          await get().refreshSuggestion();
        } else {
          void get().refreshPonder();
        }
      }
    }

    if (nextState.finished) {
      await get().endGame();
    }
  },

  setSuggestionsEnabled: async (enabled) => {
    set({ suggestionsEnabled: enabled });
    get().persistSession();
    if (enabled) {
      const { state, config: session } = get();
      if (
        session &&
        (get().suggestionsForAll || state.currentTurn === session.userColor)
      ) {
        await get().refreshSuggestion();
      } else {
        void get().refreshPonder();
      }
    } else {
      set({ suggestion: null, suggestionTip: '', searchProgress: null, analyzing: false });
    }
  },

  setSuggestionsForAll: async (forAll) => {
    set({ suggestionsForAll: forAll });
    get().persistSession();
    if (get().suggestionsEnabled) {
      await get().refreshSuggestion();
    }
  },

  setAlgoVersion: async (version) => {
    if (get().algoVersion === version) {
      return;
    }
    set({ algoVersion: version, suggestion: null, suggestionTip: '' });
    get().persistSession();
    if (get().suggestionsEnabled) {
      const { state, config: session } = get();
      if (
        session &&
        !state.finished &&
        (get().suggestionsForAll || state.currentTurn === session.userColor)
      ) {
        await get().refreshSuggestion();
      } else if (session && !state.finished) {
        void get().refreshPonder();
      }
    }
  },

  selectPiece: (pieceId) => {
    if (pieceId === null) {
      set({ selection: EMPTY_SELECTION });
      return;
    }
    const firstCell = PIECES[pieceId].cells[0];
    set({
      selection: {
        pieceId,
        rotations: 0,
        flipped: false,
        basePin: { ...firstCell },
      },
    });
  },

  clearSelection: () => {
    set({ selection: EMPTY_SELECTION });
  },

  rotateSelection: (direction = 1) => {
    const { selection } = get();
    if (selection.pieceId === null) {
      return;
    }
    set({
      selection: {
        ...selection,
        rotations: (((selection.rotations + direction) % 4) + 4) % 4,
      },
    });
  },

  flipSelection: () => {
    const { selection } = get();
    if (selection.pieceId === null) {
      return;
    }
    set({
      selection: {
        ...selection,
        flipped: !selection.flipped,
      },
    });
  },

  setPin: (pinInCurrentShape) => {
    const { selection } = get();
    if (selection.pieceId === null) {
      return;
    }
    // Convert current-shape pin back to base coordinates by inverse transform
    const inverse = getShapeFromTransform(
      selection.pieceId,
      (4 - (selection.rotations % 4)) % 4,
      selection.flipped,
    );
    // Better: search base cells that map to this pin under current transform
    const base = PIECES[selection.pieceId].cells;
    const mapped = base.find((cell) => {
      const transformed = getShapeFromTransform(
        selection.pieceId!,
        selection.rotations,
        selection.flipped,
      ).pinFor(cell);
      return transformed.x === pinInCurrentShape.x && transformed.y === pinInCurrentShape.y;
    });
    if (mapped) {
      set({ selection: { ...selection, basePin: { ...mapped } } });
      return;
    }
    // Fallback: treat pin as already in base if inverse fails
    void inverse;
    set({ selection: { ...selection, basePin: { ...pinInCurrentShape } } });
  },

  placeAt: async (x, y) => {
    const { state, config, selection, suggestionsEnabled } = get();
    if (!config || state.finished || selection.pieceId === null) {
      return;
    }

    const shape = getSelectionShape(selection);
    if (!shape) {
      return;
    }

    const move = isLegalPlacementWithPin(
      state,
      state.currentTurn,
      selection.pieceId,
      shape.orientationIndex,
      { x, y },
      shape.pin,
    );
    if (!move) {
      return;
    }

    const stateBefore = state;
    const nextState = applyMove(state, move);
    const moveIndex = stateBefore.moveHistory.length;

    set({
      state: nextState,
      selection: EMPTY_SELECTION,
      suggestion: null,
      suggestionTip: '',
      analyzing: config.userColor === move.color,
      liveFeedback: null,
    });
    get().persistSession();

    if (config.userColor === move.color) {
      const response = await requestPlayedMoveAnalysis(
        {
          type: 'analyzePlayedMove',
          stateBefore,
          played: move,
          player: move.color,
          timeLimitMs: suggestionsEnabled ? 2200 : 800,
          version: get().algoVersion,
          iterationBudget: UI_SEARCH_ITERATIONS,
        },
        (progress) => {
          set({ searchProgress: progress, analyzing: true });
        },
      );

      const analysis: MoveAnalysis = {
        moveIndex,
        played: move,
        best: response.bestMove,
        quality: response.quality,
        delta: response.delta,
        reasons: response.reasons,
      };

      set((current) => ({
        analyzing: false,
        moveAnalyses: [...current.moveAnalyses, analysis],
        liveFeedback: {
          moveIndex,
          quality: response.quality,
          visible: visibleQuality(response.quality),
        },
      }));
      get().persistSession();
    }

    if (
      suggestionsEnabled &&
      !nextState.finished &&
      (get().suggestionsForAll || nextState.currentTurn === config.userColor)
    ) {
      await get().refreshSuggestion();
    } else if (suggestionsEnabled && !nextState.finished && config.userColor !== nextState.currentTurn) {
      void get().refreshPonder();
    }

    if (nextState.finished) {
      await get().endGame();
    }
  },

  pass: async () => {
    const { state } = get();
    if (state.finished) {
      return;
    }
    const nextState = passTurn(state);
    set({
      state: nextState,
      selection: EMPTY_SELECTION,
      suggestion: null,
      suggestionTip: '',
    });
    get().persistSession();
    const config = get().config;
    if (get().suggestionsEnabled && config && !nextState.finished) {
      if (get().suggestionsForAll || nextState.currentTurn === config.userColor) {
        await get().refreshSuggestion();
      } else {
        void get().refreshPonder();
      }
    }
    if (nextState.finished) {
      await get().endGame();
    }
  },

  undo: () => {
    const next = undoMove(get().state);
    set({
      state: next,
      selection: EMPTY_SELECTION,
      liveFeedback: null,
      moveAnalyses: get().moveAnalyses.filter((entry) => entry.moveIndex < next.moveHistory.length),
      reviewIndex: null,
      reviewAnalysis: null,
      phase: next.finished ? 'review' : get().phase === 'review' ? 'playing' : get().phase,
    });
    get().persistSession();
  },

  endGame: async () => {
    const { state, config, moveAnalyses } = get();
    if (!config) {
      return;
    }

    set({
      phase: 'review',
      analyzing: true,
      state: { ...state, finished: true },
      fullState: { ...state, finished: true },
    });

    const userMoveIndices = state.moveHistory
      .map((move, index) => ({ move, index }))
      .filter(({ move }) => move.type === 'place' && move.color === config.userColor)
      .map(({ index }) => index);

    const missing = userMoveIndices.filter(
      (index) => !moveAnalyses.some((entry) => entry.moveIndex === index),
    );

    if (missing.length > 0) {
      const response = await requestBatchAnalysis({
        type: 'batchAnalyze',
        state,
        player: config.userColor,
        moveIndices: missing,
        timeLimitMs: 3000,
        version: get().algoVersion,
        iterationBudget: UI_SEARCH_ITERATIONS,
      });
      set((current) => ({
        moveAnalyses: [...current.moveAnalyses, ...response.analyses].sort(
          (a, b) => a.moveIndex - b.moveIndex,
        ),
      }));
    }

    set({ analyzing: false });
    get().persistSession();
  },

  jumpToMove: (moveIndex) => {
    const { fullState, state, moveAnalyses } = get();
    const source = fullState ?? state;
    const reviewState = getStateAtMoveIndex(source, moveIndex);
    const analysis = moveAnalyses.find((entry) => entry.moveIndex === moveIndex) ?? null;
    set({
      reviewIndex: moveIndex,
      reviewAnalysis: analysis,
      state: reviewState,
      phase: 'review',
      selection: EMPTY_SELECTION,
    });
  },

  loadSavedSession: () => {
    const saved = loadSession();
    if (!saved) {
      return;
    }
    const openingMode = saved.config.openingMode ?? saved.state.openingMode ?? 'corner';
    const config = { ...saved.config, openingMode };
    const state = { ...saved.state, openingMode };
    set({
      config,
      state,
      fullState: state.finished ? state : null,
      suggestionsEnabled: saved.suggestionsEnabled,
      suggestionsForAll: saved.suggestionsForAll ?? false,
      algoVersion: isUiAlgoVersion(saved.algoVersion)
        ? saved.algoVersion
        : DEFAULT_UI_ALGO_VERSION,
      moveAnalyses: saved.moveAnalyses,
      reviewIndex: saved.reviewIndex,
      phase: state.finished ? 'review' : 'playing',
    });
  },

  persistSession: () => {
    const {
      config,
      state,
      fullState,
      suggestionsEnabled,
      suggestionsForAll,
      algoVersion,
      moveAnalyses,
      reviewIndex,
    } = get();
    if (!config) {
      return;
    }
    saveSession({
      config,
      state: fullState ?? state,
      suggestionsEnabled,
      suggestionsForAll,
      algoVersion,
      moveAnalyses,
      reviewIndex,
    });
  },

  refreshPonder: async () => {
    const { state, config, suggestionsEnabled } = get();
    if (!config || !suggestionsEnabled || state.finished) {
      return;
    }
    if (state.currentTurn === config.userColor) {
      return;
    }
    const historyLength = state.moveHistory.length;
    try {
      await requestPonder({
        type: 'ponder',
        state,
        player: config.userColor,
        timeLimitMs: 2500,
        version: get().algoVersion,
      });
    } catch {
      // Ponder is best-effort; suggestion search will rebuild if needed.
    }
    if (get().state.moveHistory.length !== historyLength) {
      return;
    }
  },

  refreshSuggestion: async () => {
    const { state, config, suggestionsEnabled, suggestionsForAll } = get();
    if (!config || !suggestionsEnabled || state.finished) {
      set({ suggestion: null, suggestionTip: '', analyzing: false, searchProgress: null });
      return;
    }
    if (!suggestionsForAll && state.currentTurn !== config.userColor) {
      set({ suggestion: null, suggestionTip: '', analyzing: false, searchProgress: null });
      return;
    }

    const player = state.currentTurn;
    set({
      analyzing: true,
      suggestion: null,
      suggestionTip: '',
      searchProgress: {
        phase: 'starting',
        percent: 1,
        iterations: 0,
        maxIterations: 1,
        elapsedMs: 0,
        timeLimitMs: 3200,
        candidates: 0,
      },
    });
    try {
      const response = await requestSuggestion(
        {
          type: 'suggestMove',
          state,
          player,
          // Longer budget so early-game MCTS can run; progress updates keep UI informed.
          timeLimitMs: 3200,
          version: get().algoVersion,
          iterationBudget: UI_SEARCH_ITERATIONS,
        },
        (progress) => {
          set({ searchProgress: progress, analyzing: true });
        },
      );
      // Ignore stale results if the turn advanced while searching.
      if (get().state.currentTurn !== player || get().state.moveHistory.length !== state.moveHistory.length) {
        return;
      }
      set({
        analyzing: false,
        searchProgress: null,
        suggestion: response.bestMove,
        suggestionTip: response.tip,
      });
    } catch (error) {
      if (get().state.currentTurn !== player) {
        return;
      }
      set({
        analyzing: false,
        searchProgress: null,
        suggestion: null,
        suggestionTip: error instanceof Error ? error.message : 'Suggestion failed',
      });
    }
  },

  refreshWinOdds: async () => {
    const requestId = get().oddsRequestId + 1;
    const state = get().state;
    const previousOdds = get().winOdds;
    const moveCount = state.moveHistory.length;
    const total = moveCount < 8 ? 100 : moveCount < 24 ? 140 : 180;
    set({
      oddsRequestId: requestId,
      oddsUpdating: true,
      oddsSimulationsDone: 0,
      oddsSimulationsTotal: total,
    });

    try {
      const response = await requestWinOdds(state, total, (done, simTotal) => {
        if (get().oddsRequestId !== requestId) {
          return;
        }
        set({
          oddsSimulationsDone: done,
          oddsSimulationsTotal: simTotal,
          oddsUpdating: true,
        });
      });
      if (get().oddsRequestId !== requestId) {
        return;
      }
      set({
        winOdds: smoothWinOdds(previousOdds, response.odds, moveCount === 0 ? 1 : 0.7),
        oddsUpdating: false,
        oddsSimulationsDone: total,
        oddsSimulationsTotal: total,
      });
    } catch {
      if (get().oddsRequestId !== requestId) {
        return;
      }
      set({ oddsUpdating: false });
    }
  },
}));

export function getTrayCorner(
  color: PlayerColor,
): 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left' {
  switch (color) {
    case 'blue':
      return 'top-left';
    case 'yellow':
      return 'top-right';
    case 'purple':
      return 'bottom-right';
    case 'green':
      return 'bottom-left';
  }
}

export function isUserTurn(config: SessionConfig | null, state: GameState): boolean {
  return !!config && state.currentTurn === config.userColor;
}

export function getMoveLabel(move: GameMove, index: number): string {
  if (move.type === 'pass') {
    return `#${index + 1} ${move.color} pass`;
  }
  return `#${index + 1} ${move.color} ${move.pieceId}`;
}

export { PLAYER_COLORS };
