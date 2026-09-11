export const BOARD_SIZE = 20;

export const PLAYER_COLORS = ['blue', 'yellow', 'purple', 'green'] as const;
export type PlayerColor = (typeof PLAYER_COLORS)[number];

export const TURN_ORDER: PlayerColor[] = ['blue', 'green', 'purple', 'yellow'];

export const START_CORNERS: Record<PlayerColor, { x: number; y: number }> = {
  blue: { x: 0, y: 0 },
  yellow: { x: 19, y: 0 },
  purple: { x: 19, y: 19 },
  green: { x: 0, y: 19 },
};

/** First-move rule: classic corner cover, or any placement fully inside the player's quarter. */
export type OpeningMode = 'corner' | 'anywhere';

export interface BoardQuarter {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const HALF = BOARD_SIZE / 2;

/** Blue TL, Yellow TR, Purple BR, Green BL — each is a 10×10 quadrant on a 20×20 board. */
export const PLAYER_QUARTERS: Record<PlayerColor, BoardQuarter> = {
  blue: { minX: 0, maxX: HALF - 1, minY: 0, maxY: HALF - 1 },
  yellow: { minX: HALF, maxX: BOARD_SIZE - 1, minY: 0, maxY: HALF - 1 },
  purple: { minX: HALF, maxX: BOARD_SIZE - 1, minY: HALF, maxY: BOARD_SIZE - 1 },
  green: { minX: 0, maxX: HALF - 1, minY: HALF, maxY: BOARD_SIZE - 1 },
};

export const COLOR_LABELS: Record<PlayerColor, string> = {
  blue: 'Blue',
  yellow: 'Yellow',
  purple: 'Purple',
  green: 'Green',
};

export interface Cell {
  x: number;
  y: number;
}

export interface PieceDefinition {
  id: number;
  name: string;
  cells: Cell[];
  size: number;
}

export interface PieceOrientation {
  id: number;
  cells: Cell[];
}

export interface Move {
  color: PlayerColor;
  pieceId: number;
  anchor: Cell;
  orientationIndex: number;
  absoluteCells: Cell[];
}

export interface PassMove {
  type: 'pass';
  color: PlayerColor;
}

export interface PlaceMove {
  type: 'place';
  color: PlayerColor;
  pieceId: number;
  anchor: Cell;
  orientationIndex: number;
  absoluteCells: Cell[];
}

export type GameMove = PlaceMove | PassMove;

export type MoveQuality = 'best' | 'good' | 'inaccuracy' | 'blunder';

export interface MoveAnalysis {
  moveIndex: number;
  played: PlaceMove;
  best: PlaceMove | null;
  quality: MoveQuality;
  delta: number;
  reasons: string[];
}

export interface GameState {
  board: (PlayerColor | null)[][];
  remainingPieces: Record<PlayerColor, number[]>;
  currentTurn: PlayerColor;
  hasPlayed: Record<PlayerColor, boolean>;
  consecutivePasses: number;
  moveHistory: GameMove[];
  lastPlacedPieceId: Record<PlayerColor, number | null>;
  finished: boolean;
  openingMode: OpeningMode;
}

export interface SessionConfig {
  userColor: PlayerColor;
  userName: string;
  openingMode: OpeningMode;
}

export interface SavedSession {
  config: SessionConfig;
  state: GameState;
  suggestionsEnabled: boolean;
  /** When true, suggest moves for every color's turn; otherwise only the user's. */
  suggestionsForAll?: boolean;
  /** Live-game next-move engine. Absent on older saves; the UI falls back to `v3.1`. */
  algoVersion?: string;
  moveAnalyses: MoveAnalysis[];
  reviewIndex: number | null;
}
