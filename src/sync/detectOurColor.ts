import { PLAYER_COLORS, START_CORNERS, TURN_ORDER } from '../engine/types';
import type { PlayerColor } from '../engine/types';
import type { ExternalBoard } from './types';

export type SeatInfo = {
  color: PlayerColor;
  index: number;
  name: string | null;
  userId: string | null;
  isBot: boolean;
};

export type DomSeatInfo = {
  color: PlayerColor;
  name: string | null;
  isBot: boolean;
  hasPass: boolean;
  isActive: boolean;
};

export type SeatSnapshot = {
  board?: ExternalBoard | null;
  userId?: string | null;
  username?: string | null;
  seats?: SeatInfo[];
  domSeats?: DomSeatInfo[];
};

export type SeatDetection = {
  color: PlayerColor | null;
  reason: string;
  scores: Record<PlayerColor, number>;
};

const EMPTY_SCORES: Record<PlayerColor, number> = {
  blue: 0,
  yellow: 0,
  purple: 0,
  green: 0,
};

function namesMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  const a = left.replace(/\(.*\)$/, '').trim().toLowerCase();
  const b = right.replace(/\(.*\)$/, '').trim().toLowerCase();
  return a.length > 0 && a === b;
}

function isGuestName(name: string | null | undefined): boolean {
  return Boolean(name && /^guest\d+/i.test(name.trim()));
}

function looksLikeHumanName(name: string | null | undefined): boolean {
  if (!name) {
    return false;
  }
  if (/\b(cpu|bot|ai|computer)\b/i.test(name)) {
    return false;
  }
  return isGuestName(name) || /^[a-z][a-z0-9_-]{2,}$/i.test(name.replace(/\(.*\)$/, '').trim());
}

/** Colors that already occupy at least one square. */
export function colorsPresent(board: ExternalBoard | null | undefined): PlayerColor[] {
  if (!board || board.length < 20) {
    return [];
  }
  const seen = new Set<PlayerColor>();
  for (const row of board) {
    for (const cell of row) {
      if (cell && PLAYER_COLORS.includes(cell)) {
        seen.add(cell);
      }
    }
  }
  return PLAYER_COLORS.filter((color) => seen.has(color));
}

export function cellCounts(board: ExternalBoard | null | undefined): Record<PlayerColor, number> {
  const counts: Record<PlayerColor, number> = { blue: 0, yellow: 0, purple: 0, green: 0 };
  if (!board) {
    return counts;
  }
  for (const row of board) {
    for (const cell of row) {
      if (cell && PLAYER_COLORS.includes(cell)) {
        counts[cell] += 1;
      }
    }
  }
  return counts;
}

/**
 * Whose turn it is on the live board.
 * Pass (your tray) outranks Meteor `isActive`, which often stays on Blue after Blue has moved.
 * Opening round: first in Blue → Green → Purple → Yellow who has not opened.
 * Later: the unique color with the fewest squares is behind in the round (e.g. Yellow
 * still on 5 cells while everyone else has 10).
 */
export function inferCurrentTurn(input: {
  scrapedTurn?: PlayerColor | null;
  passColor?: PlayerColor | null;
  board?: ExternalBoard | null;
  ourColor?: PlayerColor | null;
}): { turn: PlayerColor | null; reason: string } {
  if (input.passColor) {
    return { turn: input.passColor, reason: `Pass control is on ${input.passColor}` };
  }

  const opened = colorsPresent(input.board);
  const unopened = TURN_ORDER.filter((color) => !opened.includes(color));
  if (opened.length > 0 && unopened.length > 0) {
    // Meteor often keeps isActive on someone who already placed (usually Blue).
    // Trust a scraped seat only if that seat still has not opened — that also
    // covers a genuine first-round pass (Green skips, Purple to move).
    if (input.scrapedTurn && unopened.includes(input.scrapedTurn)) {
      return {
        turn: input.scrapedTurn,
        reason: `${opened.join(', ')} already opened; scrape still waiting on ${input.scrapedTurn}`,
      };
    }
    const next = unopened[0];
    return {
      turn: next,
      reason: `${opened.join(', ')} already opened; first-round next is ${next}`,
    };
  }

  const counts = cellCounts(input.board);
  if (opened.length > 0) {
    const min = Math.min(...opened.map((color) => counts[color]));
    const max = Math.max(...opened.map((color) => counts[color]));
    const behind = opened.filter((color) => counts[color] === min);
    if (behind.length === 1 && min < max) {
      return {
        turn: behind[0],
        reason: `${behind[0]} is behind on squares (${min} vs others)`,
      };
    }
    if (
      input.ourColor &&
      opened.includes(input.ourColor) &&
      counts[input.ourColor] === min &&
      min < max
    ) {
      return {
        turn: input.ourColor,
        reason: `${input.ourColor} is behind on squares (${min} vs ${max})`,
      };
    }
  }

  if (input.scrapedTurn) {
    return { turn: input.scrapedTurn, reason: `scrape reported ${input.scrapedTurn}` };
  }

  return {
    turn: null,
    reason: `turn unknown (pass=${input.passColor ?? 'none'} cells=${opened
      .map((color) => `${color}:${counts[color]}`)
      .join(',')})`,
  };
}

export function emptyOpeningCorners(board: ExternalBoard | null | undefined): PlayerColor[] {
  if (!board || board.length < 20) {
    return [];
  }
  return PLAYER_COLORS.filter((color) => {
    const { x, y } = START_CORNERS[color];
    return !board[y]?.[x];
  });
}

/**
 * Pick the local human seat. Mattle’s Yellow (top-right) and Green (bottom-left)
 * are easy to swap from Meteor playerIndex stubs, so DOM Pass/CPU labels and
 * opening-corner occupancy outrank a lone `!isBot` seat.
 */
export function detectOurColor(snapshot: SeatSnapshot): SeatDetection {
  const scores: Record<PlayerColor, number> = { ...EMPTY_SCORES };
  const notes: string[] = [];

  for (const seat of snapshot.domSeats ?? []) {
    if (!PLAYER_COLORS.includes(seat.color)) {
      continue;
    }
    if (seat.hasPass) {
      scores[seat.color] += 8;
      notes.push(`Pass button in ${seat.color} panel`);
    }
    if (seat.isActive && !seat.isBot) {
      scores[seat.color] += 2;
    }
    if (seat.isBot) {
      scores[seat.color] -= 6;
      notes.push(`${seat.color} panel labeled CPU`);
    } else {
      scores[seat.color] += 4;
    }
    if (looksLikeHumanName(seat.name)) {
      scores[seat.color] += 2;
      if (namesMatch(seat.name, snapshot.username) || isGuestName(seat.name)) {
        scores[seat.color] += 2;
        notes.push(`${seat.color} panel name ${seat.name}`);
      }
    }
  }

  for (const seat of snapshot.seats ?? []) {
    if (!PLAYER_COLORS.includes(seat.color)) {
      continue;
    }
    const idMatch = Boolean(seat.userId && snapshot.userId && seat.userId === snapshot.userId);
    const namedHuman = looksLikeHumanName(seat.name) && !seat.isBot;
    if (seat.isBot) {
      scores[seat.color] -= 3;
    }
    if (idMatch) {
      scores[seat.color] += 3;
      notes.push(`Meteor userId on ${seat.color}`);
    }
    if (namedHuman) {
      scores[seat.color] += 2;
    }
  }

  const emptyCorners = emptyOpeningCorners(snapshot.board ?? null);
  if (emptyCorners.length === 1) {
    const [empty] = emptyCorners;
    scores[empty] += 4;
    notes.push(`only ${empty} start corner is empty`);
  }

  const ranked = [...PLAYER_COLORS].sort((a, b) => scores[b] - scores[a]);
  const best = ranked[0];
  const second = ranked[1];
  const margin = scores[best] - scores[second];

  const yellowGreenClose =
    (best === 'yellow' && second === 'green') || (best === 'green' && second === 'yellow');

  const domPass = (snapshot.domSeats ?? []).find((seat) => seat.hasPass && !seat.isBot);
  if (domPass) {
    return {
      color: domPass.color,
      reason: `Pass control is in the ${domPass.color} corner panel`,
      scores,
    };
  }

  const domHumans = (snapshot.domSeats ?? []).filter((seat) => !seat.isBot);
  if (domHumans.length === 1) {
    return {
      color: domHumans[0].color,
      reason: `only non-CPU corner panel is ${domHumans[0].color}${domHumans[0].name ? ` (${domHumans[0].name})` : ''}`,
      scores,
    };
  }

  if (yellowGreenClose && margin < 4 && emptyCorners.length !== 1) {
    return {
      color: null,
      reason: `yellow vs green still tied (${scores.yellow} vs ${scores.green}); waiting for Pass/CPU panels`,
      scores,
    };
  }

  if (scores[best] <= 0) {
    return { color: null, reason: notes.join('; ') || 'no human seat signal yet', scores };
  }

  if (margin === 0) {
    return { color: null, reason: `tied between ${best} and ${second}`, scores };
  }

  return {
    color: best,
    reason: notes[0] ?? `highest seat score ${best} (${scores[best]})`,
    scores,
  };
}
