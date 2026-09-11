/**
 * Supervised live eval: 1 human seat (our engine) vs 3 CPUs on blokee.mattle.online.
 *
 * Usage:
 *   npm run live-cpu-eval -- --manual-lobby
 *   npm run live-cpu-eval -- --manual-lobby --auto-click
 *
 * You log in (or Play as Guest) in the headed browser, then create a 3-CPU game.
 * Your seat color is detected when the match starts. `--color` is an optional override.
 * Default is semi-auto: we print our move and wait until you place it on the live board.
 *
 * Results append to scripts/live-cpu-results.jsonl
 */
import { appendFile, access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { clearLegalMoveCache } from '../src/ai/legalMoveCache.ts';
import { formatMoveDiagram, formatPieceCatalog } from '../src/ai/moveDiagram.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { detectOurColor, inferCurrentTurn } from '../src/sync/detectOurColor.ts';
import type { DomSeatInfo, SeatInfo } from '../src/sync/detectOurColor.ts';
import { hydrateFromExternalBoard } from '../src/sync/hydrate.ts';
import type { ExternalBoard } from '../src/sync/types.ts';
import type { PlaceMove, PlayerColor } from '../src/engine/types.ts';
import { calculateScores, isLegalPlacement } from '../src/engine/game.ts';
import { MATTLE_ORIGIN, mattleSelectors } from './mattleSelectors.ts';

const SCRAPE_JS = await readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'mattleScrapeEvaluate.js'),
  'utf8',
);

const RESULTS_PATH = path.resolve('scripts/live-cpu-results.jsonl');
const AUTH_DIR = path.resolve('playwright/.auth');
const AUTH_FILE = path.join(AUTH_DIR, 'mattle.json');

const PLAYER_COLORS: PlayerColor[] = ['blue', 'yellow', 'purple', 'green'];

type BoardSnapshot = {
  board: ExternalBoard | null;
  currentTurn: PlayerColor | null;
  source: string;
  userId?: string | null;
  username?: string | null;
  seats?: SeatInfo[];
  domSeats?: DomSeatInfo[];
  status?: string | null;
  gameKeys?: string[];
};

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function countColor(board: ExternalBoard, color: PlayerColor): number {
  let count = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell === color) {
        count += 1;
      }
    }
  }
  return count;
}

function fingerprint(board: ExternalBoard | null): string {
  if (!board) {
    return '';
  }
  return board
    .map((row) => row.map((cell) => cell?.[0] ?? '.').join(''))
    .join('|');
}

function isPlayerColor(value: string | null | undefined): value is PlayerColor {
  return PLAYER_COLORS.includes(value as PlayerColor);
}

async function scrapeBoard(page: Page): Promise<BoardSnapshot> {
  try {
    const raw = (await page.evaluate(SCRAPE_JS)) as BoardSnapshot;
    return {
      board: raw?.board ?? null,
      currentTurn: isPlayerColor(raw?.currentTurn) ? raw.currentTurn : null,
      source: raw?.source ?? 'none',
      userId: raw?.userId ?? null,
      username: raw?.username ?? null,
      seats: Array.isArray(raw?.seats) ? raw.seats : [],
      domSeats: Array.isArray(raw?.domSeats) ? raw.domSeats : [],
      status: raw?.status ?? null,
      gameKeys: raw?.gameKeys ?? [],
    };
  } catch (error) {
    return {
      board: null,
      currentTurn: null,
      source: `evaluate-error:${error instanceof Error ? error.message : String(error)}`,
      userId: null,
      username: null,
      seats: [],
      domSeats: [],
    };
  }
}

function remapNumericBoard(board: ExternalBoard): ExternalBoard {
  const map: Record<string, PlayerColor> = {
    '0': 'blue',
    '1': 'green',
    '2': 'purple',
    '3': 'yellow',
    blue: 'blue',
    green: 'green',
    purple: 'purple',
    yellow: 'yellow',
    red: 'purple',
  };
  return board.map((row) =>
    row.map((cell) => {
      if (!cell) {
        return null;
      }
      return map[String(cell).toLowerCase()] ?? null;
    }),
  ) as ExternalBoard;
}

async function tryClickSelector(page: Page, selector: string): Promise<boolean> {
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) {
    return false;
  }
  try {
    await locator.click({ timeout: 2500 });
    return true;
  } catch {
    return false;
  }
}

async function createCpuGame(page: Page): Promise<void> {
  await tryClickSelector(page, mattleSelectors.playAsGuest);
  await page.waitForTimeout(1500);
  await tryClickSelector(page, mattleSelectors.createGame);
  await page.waitForTimeout(800);
  for (let i = 0; i < 3; i += 1) {
    const added = await tryClickSelector(page, mattleSelectors.addCpu);
    if (!added) {
      break;
    }
    await page.waitForTimeout(400);
  }
  await tryClickSelector(page, mattleSelectors.startGame);
}

async function clickMoveOnCanvas(page: Page, move: PlaceMove): Promise<boolean> {
  const canvas = page.locator(mattleSelectors.boardCanvas).first();
  if ((await canvas.count()) === 0) {
    return false;
  }
  const box = await canvas.boundingBox();
  if (!box) {
    return false;
  }
  const cellW = box.width / 20;
  const cellH = box.height / 20;
  for (const cell of move.absoluteCells) {
    await page.mouse.click(box.x + (cell.x + 0.5) * cellW, box.y + (cell.y + 0.5) * cellH);
    await page.waitForTimeout(80);
  }
  return true;
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: false, channel: 'chrome' });
  } catch {
    try {
      return await chromium.launch({ headless: false });
    } catch (error) {
      console.error(
        'Playwright could not find Chrome or Chromium.\n' +
          'Install the browser once with:\n' +
          '  npm run live-cpu-eval:install',
      );
      throw error;
    }
  }
}

async function waitForBoardChange(page: Page, previous: string, timeoutMs: number): Promise<BoardSnapshot> {
  const started = Date.now();
  let snapshot = await scrapeBoard(page);
  while (Date.now() - started < timeoutMs) {
    if (fingerprint(snapshot.board) !== previous && snapshot.board) {
      return snapshot;
    }
    await page.waitForTimeout(400);
    snapshot = await scrapeBoard(page);
  }
  return snapshot;
}

async function main(): Promise<void> {
  const manualLobby = flag('manual-lobby');
  const autoClick = flag('auto-click');
  const colorOverride = arg('color');
  const policyMs = Number(arg('time-ms', '3200'));

  await mkdir(AUTH_DIR, { recursive: true });
  let storageState: string | undefined;
  try {
    await access(AUTH_FILE);
    storageState = AUTH_FILE;
  } catch {
    storageState = undefined;
  }
  const browser = await launchBrowser();
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto(MATTLE_ORIGIN, { waitUntil: 'domcontentloaded' });

  console.log('Logged-in / guest session: complete any sign-in in the opened window.');
  console.log('Prefer an unrated practice room. Close the window to abort.');
  console.log('Your seat color is detected when the game starts; no need to pass --color.');
  console.log(
    'Coordinates: (x,y) is (column, row). (7,4) = column 7, row 4 — not row 7, column 4.',
  );
  console.log('Default piece shapes (suggestions print the rotated/flipped orientation on the board):\n');
  console.log(formatPieceCatalog());
  console.log('');

  if (!manualLobby) {
    console.log('Attempting to create a 1-human + 3-CPU game…');
    await createCpuGame(page);
    console.log('If the room is not ready, finish setup in the browser (add 3 CPUs, start).');
  } else {
    console.log('Manual lobby: create a game with 3 CPUs, then wait — the script will pick up the board.');
  }

  const startedAt = Date.now();
  let lastFingerprint = '';
  let ourMoves = 0;
  const colorLocked = Boolean(colorOverride && isPlayerColor(colorOverride));
  let ourColor: PlayerColor | null =
    colorOverride && isPlayerColor(colorOverride) ? colorOverride : null;
  let lastWaitLog = 0;
  let awaitingOurPlacement = false;
  let ourCellsWhenSuggested = 0;
  let oppCellsWhenSuggested = 0;

  while (Date.now() - startedAt < 40 * 60 * 1000) {
    const snapshot = await scrapeBoard(page);
    const remappedBoard = snapshot.board ? remapNumericBoard(snapshot.board) : null;
    if (!colorLocked) {
      const detection = detectOurColor({
        board: remappedBoard,
        userId: snapshot.userId,
        username: snapshot.username,
        seats: snapshot.seats,
        domSeats: snapshot.domSeats,
      });
      if (detection.color && detection.color !== ourColor) {
        if (ourColor) {
          console.log(`Seat correction: ${ourColor} → ${detection.color} (${detection.reason})`);
        } else {
          console.log(`Detected your seat: ${detection.color} (${detection.reason})`);
        }
        ourColor = detection.color;
      }
    }

    if (!snapshot.board) {
      if (Date.now() - lastWaitLog > 8000) {
        lastWaitLog = Date.now();
        console.log(`Waiting for a live board… (${snapshot.source})`);
      }
      await page.waitForTimeout(800);
      continue;
    }

    if (!ourColor) {
      if (Date.now() - lastWaitLog > 8000) {
        lastWaitLog = Date.now();
        const seatSummary =
          snapshot.seats?.map((seat) => `${seat.color}${seat.isBot ? '/cpu' : '/you?'}`).join(', ') ||
          'no seats yet';
        const domSummary =
          snapshot.domSeats?.map((seat) => `${seat.color}${seat.hasPass ? '/pass' : seat.isBot ? '/cpu' : ''}`).join(', ') ||
          'no panels';
        console.log(`Game visible, still detecting your color (meteor: ${seatSummary}; panels: ${domSummary}).`);
      }
      await page.waitForTimeout(800);
      continue;
    }

    const board = remappedBoard ?? remapNumericBoard(snapshot.board);
    const print = fingerprint(board);
    const filled = board.flat().filter(Boolean).length;
    const passColor = snapshot.domSeats?.find((seat) => seat.hasPass)?.color ?? null;
    const inferredTurn = inferCurrentTurn({
      scrapedTurn: snapshot.currentTurn,
      passColor,
      board: filled > 0 ? board : null,
      ourColor,
    });
    const turn = inferredTurn.turn;

    if (filled === 0) {
      if (Date.now() - lastWaitLog > 8000) {
        lastWaitLog = Date.now();
        console.log(
          `Board scrape is empty (${snapshot.source}); ${inferredTurn.reason}. Not treating that as Blue to move.`,
        );
      }
      await page.waitForTimeout(500);
      continue;
    }

    const hydrated = hydrateFromExternalBoard(board, turn ?? undefined);
    if (!hydrated.state) {
      await page.waitForTimeout(400);
      continue;
    }
    if (turn) {
      hydrated.state.currentTurn = turn;
    }

    const ourCells = countColor(board, ourColor);
    const oppCells = filled - ourCells;

    if (!turn) {
      if (Date.now() - lastWaitLog > 8000) {
        lastWaitLog = Date.now();
        console.log(`Turn unknown (${inferredTurn.reason}); not assuming Blue.`);
      }
      await page.waitForTimeout(500);
      continue;
    }

    if (turn !== ourColor) {
      awaitingOurPlacement = false;
      if (print !== lastFingerprint || Date.now() - lastWaitLog > 8000) {
        lastWaitLog = Date.now();
        console.log(`Waiting on ${turn} (CPU)… ${inferredTurn.reason}`);
      }
      lastFingerprint = print;
      await page.waitForTimeout(500);
      continue;
    }

    if (hydrated.state.finished) {
      break;
    }

    if (awaitingOurPlacement) {
      const placedSince = ourCells > ourCellsWhenSuggested;
      const cpusMoved = oppCells > oppCellsWhenSuggested;
      if (cpusMoved || (placedSince && turn === ourColor)) {
        awaitingOurPlacement = false;
      } else {
        if (Date.now() - lastWaitLog > 8000) {
          lastWaitLog = Date.now();
          if (placedSince) {
            console.log('Saw your placement. Waiting for CPUs before the next suggestion…');
          } else {
            console.log('Already suggested this turn. Place that piece; will not search again until CPUs move.');
          }
        }
        await page.waitForTimeout(500);
        continue;
      }
    }

    if (print === lastFingerprint) {
      const over = await page.locator(mattleSelectors.gameOver).first().count();
      if (over > 0) {
        break;
      }
      await page.waitForTimeout(500);
      continue;
    }
    lastFingerprint = print;

    console.log(`Our turn (${ourColor}) — searching…`);
    clearLegalMoveCache();
    const result = await searchBestMove(hydrated.state, ourColor, policyMs);
    const legal =
      result.bestMove &&
      isLegalPlacement(
        hydrated.state,
        ourColor,
        result.bestMove.pieceId,
        result.bestMove.orientationIndex,
        result.bestMove.anchor,
        false,
      );
    if (!result.bestMove || !legal) {
      console.log('No legal move; pass or finish in the live UI.');
      await waitForBoardChange(page, lastFingerprint, 30_000);
      continue;
    }

    const move = legal;
    console.log(formatMoveDiagram(move));

    if (autoClick) {
      const clicked = await clickMoveOnCanvas(page, move);
      console.log(clicked ? 'Clicked canvas cells.' : 'Canvas click failed; place the move by hand.');
    } else {
      console.log('Semi-auto: place that piece on the live board. Waiting for the board to change…');
    }

    ourMoves += 1;
    awaitingOurPlacement = true;
    ourCellsWhenSuggested = ourCells;
    oppCellsWhenSuggested = oppCells;
    await waitForBoardChange(page, lastFingerprint, 120_000);
  }

  const finalSnap = await scrapeBoard(page);
  let scores: Record<string, number> | null = null;
  let winners: PlayerColor[] = [];
  if (finalSnap.board) {
    const hydrated = hydrateFromExternalBoard(
      remapNumericBoard(finalSnap.board),
      finalSnap.currentTurn ?? ourColor ?? undefined,
    );
    if (hydrated.state) {
      const table = calculateScores(hydrated.state);
      scores = Object.fromEntries(table.map((entry) => [entry.color, entry.score]));
      const best = Math.max(...table.map((entry) => entry.score));
      winners = table.filter((entry) => entry.score === best).map((entry) => entry.color);
    }
  }

  const record = {
    ts: new Date().toISOString(),
    ourColor,
    ourMoves,
    durationMs: Date.now() - startedAt,
    scores,
    winners,
    policyMs,
  };
  await appendFile(RESULTS_PATH, `${JSON.stringify(record)}\n`);
  await context.storageState({ path: AUTH_FILE });
  console.log(`Wrote ${RESULTS_PATH}`);
  console.log(record);
  await browser.close();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
