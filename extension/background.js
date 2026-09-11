const BLOKEE_URL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'blokee-relay') {
    void relayToBlokeeTabs(message.payload).then((count) => {
      sendResponse({ ok: true, delivered: count });
    });
    return true;
  }

  if (message.type === 'blokee-request-snapshot') {
    void requestSnapshotsFromGameTabs().then((count) => {
      sendResponse({ ok: true, requested: count });
    });
    return true;
  }

  if (message.type === 'blokee-read-page-state') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, result: null });
      return;
    }
    void readPageState(tabId).then((result) => {
      sendResponse({ ok: true, result });
    });
    return true;
  }

  if (message.type === 'blokee-ping-ext') {
    sendResponse({ ok: true, from: 'background' });
  }
});

async function relayToBlokeeTabs(payload) {
  const tabs = await chrome.tabs.query({});
  let delivered = 0;
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id || !tab.url || !BLOKEE_URL_RE.test(tab.url)) {
        return;
      }
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'blokee-from-extension',
          payload,
        });
        delivered += 1;
      } catch {
        // Content script may not be injected yet.
      }
    }),
  );
  return delivered;
}

async function requestSnapshotsFromGameTabs() {
  const tabs = await chrome.tabs.query({});
  let requested = 0;
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id || !tab.url || BLOKEE_URL_RE.test(tab.url)) {
        return;
      }
      if (!/^https?:\/\//i.test(tab.url)) {
        return;
      }
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'blokee-request-snapshot' });
        requested += 1;
      } catch {
        // Not a game tab / no content script.
      }
    }),
  );
  return requested;
}

async function readPageState(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const SIZE = 20;
        const playerIndexToColor = ['blue', 'green', 'purple', 'yellow'];

        function looksLikePassText(text) {
          const key = String(text || '')
            .replace(/\u2026/g, '...')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
          return key === 'pass' || key === 'pass...' || (key.startsWith('pass') && key.length <= 12);
        }

        function seatFromPoint(x, y, w, h) {
          const left = x < w * 0.5;
          const top = y < h * 0.5;
          if (left && top) return 'blue';
          if (!left && top) return 'yellow';
          if (!left && !top) return 'purple';
          return 'green';
        }

        function collectTurnSignals() {
          const w = window.innerWidth || 0;
          const h = window.innerHeight || 0;
          let passColor = null;
          let timerTurn = null;
          const domHits = [];
          const gfxHits = [];

          if (w >= 100 && h >= 100 && document.body) {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode();
            while (node) {
              if (looksLikePassText(node.nodeValue)) {
                const el = node.parentElement;
                if (el) {
                  const rect = el.getBoundingClientRect();
                  if (
                    rect.width >= 8 &&
                    rect.height >= 8 &&
                    rect.width <= 520 &&
                    rect.height <= 140
                  ) {
                    domHits.push({
                      x: rect.left + rect.width / 2,
                      y: rect.top + rect.height / 2,
                      area: rect.width * rect.height,
                    });
                  }
                }
              }
              node = walker.nextNode();
            }

            const labeled = document.querySelectorAll(
              'button, [class*="pass"], [class*="Pass"], [id*="pass"], [id*="Pass"], [aria-label*="pass"], [aria-label*="Pass"]',
            );
            for (let i = 0; i < labeled.length; i += 1) {
              const el = labeled[i];
              const label = `${el.getAttribute('aria-label') || ''} ${el.className || ''} ${el.id || ''}`;
              if (!looksLikePassText(el.textContent) && !/pass/i.test(label)) continue;
              const rect = el.getBoundingClientRect();
              if (rect.width < 8 || rect.height < 8 || rect.width > 520 || rect.height > 140) continue;
              domHits.push({
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                area: rect.width * rect.height,
              });
            }

            function walkDisplay(obj, depth, origin) {
              if (!obj || depth > 14) return;
              const raw = obj.text || obj._text || obj.name || '';
              if (looksLikePassText(raw)) {
                let x = Number(obj.x) || 0;
                let y = Number(obj.y) || 0;
                try {
                  if (typeof obj.localToGlobal === 'function') {
                    const g = obj.localToGlobal(0, 0);
                    x = g.x;
                    y = g.y;
                  }
                } catch (e) {
                  /* ignore */
                }
                if (Math.abs(x) + Math.abs(y) >= 8) {
                  gfxHits.push({
                    x: origin.left + x,
                    y: origin.top + y,
                    area: 40,
                  });
                }
              }
              const kids = obj.children || obj._children || [];
              for (let i = 0; i < kids.length; i += 1) {
                walkDisplay(kids[i], depth + 1, origin);
              }
            }

            const canvases = document.querySelectorAll('canvas');
            for (let c = 0; c < canvases.length; c += 1) {
              const canvas = canvases[c];
              const rect = canvas.getBoundingClientRect();
              const origin = { left: rect.left, top: rect.top };
              if (canvas.stage) walkDisplay(canvas.stage, 0, origin);
            }
            const stageKeys = ['stage', 'gameStage', 'boardStage', 'exportRoot', 'rootStage'];
            for (let s = 0; s < stageKeys.length; s += 1) {
              const value = window[stageKeys[s]];
              if (value && value.children) {
                const canvas = value.canvas;
                const rect =
                  canvas && canvas.getBoundingClientRect
                    ? canvas.getBoundingClientRect()
                    : { left: 0, top: 0 };
                walkDisplay(value, 0, { left: rect.left || 0, top: rect.top || 0 });
              }
            }

            const passHits = domHits.length > 0 ? domHits : gfxHits;
            passHits.sort((a, b) => a.area - b.area);
            if (passHits.length > 0) {
              passColor = seatFromPoint(passHits[0].x, passHits[0].y, w, h);
            }

            const headerBottom = h * 0.16;
            const nodes = document.querySelectorAll('div, span, p, label, strong, h1, h2, h3');
            for (let i = 0; i < nodes.length; i += 1) {
              const text = (nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
              if (text.length > 24) continue;
              const match = text.match(/\b(\d{1,2}):(\d{2})\b/);
              if (!match || match[0] === '10:00') continue;
              const rect = nodes[i].getBoundingClientRect();
              if (rect.height > 40 || rect.width > 120) continue;
              const cy = rect.top + rect.height / 2;
              if (cy > headerBottom) continue;
              const cx = rect.left + rect.width / 2;
              const slot = Math.min(3, Math.max(0, Math.floor((cx / w) * 4)));
              timerTurn = playerIndexToColor[slot];
              break;
            }
          }

          return { passColor, timerTurn };
        }

        const turnSignals = collectTurnSignals();

        function looksLikeBoard(value) {
          if (!Array.isArray(value)) return false;
          if (value.length === SIZE && Array.isArray(value[0]) && value[0].length === SIZE) {
            return true;
          }
          if (value.length === SIZE * SIZE && !Array.isArray(value[0])) {
            return true;
          }
          return false;
        }

        function findBoard(value, depth = 0) {
          if (value == null || depth > 7) return null;
          if (looksLikeBoard(value)) return value;
          if (Array.isArray(value)) {
            for (const item of value) {
              const found = findBoard(item, depth + 1);
              if (found) return found;
            }
            return null;
          }
          if (typeof value === 'object') {
            for (const key of ['board', 'grid', 'cells', 'squares', 'matrix', 'map', 'data']) {
              if (key in value) {
                const found = findBoard(value[key], depth + 1);
                if (found) return found;
              }
            }
            for (const item of Object.values(value)) {
              const found = findBoard(item, depth + 1);
              if (found) return found;
            }
          }
          return null;
        }

        function boardFromPlacements(placements) {
          if (!Array.isArray(placements) || placements.length === 0) return null;
          const board = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => null));
          let hits = 0;
          for (const placement of placements) {
            if (!placement || typeof placement !== 'object') continue;
            const idx = placement.playerIndex ?? placement.player ?? placement.colorIndex;
            const color =
              typeof placement.color === 'string'
                ? placement.color
                : playerIndexToColor[Number(idx)] || null;
            const cells =
              placement.cells ||
              placement.squares ||
              placement.positions ||
              placement.coords ||
              placement.points;
            if (!color || !Array.isArray(cells)) continue;
            for (const cell of cells) {
              let x;
              let y;
              if (Array.isArray(cell)) {
                x = Number(cell[0]);
                y = Number(cell[1]);
              } else if (cell && typeof cell === 'object') {
                x = Number(cell.x ?? cell.col ?? cell.c);
                y = Number(cell.y ?? cell.row ?? cell.r);
              } else continue;
              if (x >= 1 && y >= 1 && x <= SIZE && y <= SIZE) {
                x -= 1;
                y -= 1;
              }
              if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) {
                board[y][x] = color;
                hits += 1;
              }
            }
          }
          return hits > 0 ? board : null;
        }

        // --- Board Game Arena ---
        const gui = window.gameui;
        const gamedatas = gui && gui.gamedatas;
        if (gamedatas) {
          let board = findBoard(gamedatas);
          let currentTurn = null;
          if (gamedatas.gamestate && gamedatas.gamestate.active_player) {
            const pid = String(gamedatas.gamestate.active_player);
            const player = gamedatas.players && gamedatas.players[pid];
            if (player && player.color) currentTurn = player.color;
          }
          if (board) {
            return { board, currentTurn, source: 'bga-gamedatas' };
          }
        }

        // --- blokee.mattle.online (Meteor Minimongo) ---
        try {
          if (typeof Games !== 'undefined' && Games && typeof Games.find === 'function') {
            const games = Games.find({}, { sort: { updatedAt: -1 } }).fetch();
            for (const game of games) {
              if (!game) continue;
              let board = findBoard(game.data) || findBoard(game);
              if (!board && game.data) {
                board =
                  boardFromPlacements(game.data.placements) ||
                  boardFromPlacements(game.data.pieces) ||
                  boardFromPlacements(game.data.moves) ||
                  boardFromPlacements(game.data.blocks);
              }
              if (!board && Array.isArray(game.actionItems)) {
                const placements = game.actionItems
                  .map((item) => item && item.action)
                  .filter(Boolean);
                board = boardFromPlacements(placements);
              }

              let currentTurn = null;
              if (Array.isArray(game.activeStatuses)) {
                const actives = game.activeStatuses.filter((entry) => entry && entry.isActive);
                if (actives.length === 1 && Number.isFinite(actives[0].playerIndex)) {
                  currentTurn = playerIndexToColor[actives[0].playerIndex];
                }
              }
              if (!currentTurn && Number.isFinite(game.currentPlayerIndex)) {
                currentTurn = playerIndexToColor[game.currentPlayerIndex];
              }
              if (turnSignals.passColor) currentTurn = turnSignals.passColor;
              else if (turnSignals.timerTurn) currentTurn = turnSignals.timerTurn;
              if (board) {
                return {
                  board,
                  currentTurn,
                  passColor: turnSignals.passColor,
                  timerTurn: turnSignals.timerTurn,
                  source: 'meteor-Games',
                  gameKey: game.gameKey,
                  status: game.status,
                };
              }
            }
            return {
              board: null,
              currentTurn: turnSignals.passColor || turnSignals.timerTurn,
              passColor: turnSignals.passColor,
              timerTurn: turnSignals.timerTurn,
              source: 'meteor-Games-empty',
              gameCount: games.length,
              sampleKeys: games[0] ? Object.keys(games[0]) : [],
              dataKeys: games[0] && games[0].data ? Object.keys(games[0].data) : [],
            };
          }
        } catch (error) {
          return {
            board: null,
            currentTurn: turnSignals.passColor || turnSignals.timerTurn,
            passColor: turnSignals.passColor,
            timerTurn: turnSignals.timerTurn,
            source: 'meteor-error',
            error: String(error),
          };
        }

        return {
          board: null,
          currentTurn: turnSignals.passColor || turnSignals.timerTurn,
          passColor: turnSignals.passColor,
          timerTurn: turnSignals.timerTurn,
          source: 'none',
        };
      },
    });
    return result ?? null;
  } catch {
    return null;
  }
}
