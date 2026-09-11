/**
 * Single content script for Blokee Sync.
 * - On localhost coach: bridge messages into the page
 * - On game tabs (e.g. blokee.mattle.online): scrape board and relay
 *
 * One file only — Chrome shares one JS world per extension, so two files
 * both declaring const SYNC_SOURCE will crash.
 */
(function blokeeSyncContent() {
  if (globalThis.__blokeeSyncContentInstalled) {
    return;
  }
  globalThis.__blokeeSyncContentInstalled = true;

  var SOURCE = 'blokee-sync';
  var timers = [];
  var isCoach =
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1' ||
    Boolean(document.querySelector('.sync-status, .win-odds, .suggestion-banner'));

  function runtimeAlive() {
    try {
      return Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function stopIfDead() {
    if (runtimeAlive()) return false;
    for (var i = 0; i < timers.length; i += 1) {
      clearInterval(timers[i]);
      clearTimeout(timers[i]);
    }
    timers = [];
    return true;
  }

  function sendRuntime(message, onResponse) {
    if (stopIfDead()) {
      if (onResponse) onResponse(null);
      return;
    }
    try {
      chrome.runtime.sendMessage(message, function (response) {
        try {
          void chrome.runtime.lastError;
        } catch (e) {
          stopIfDead();
          if (onResponse) onResponse(null);
          return;
        }
        if (onResponse) onResponse(response);
      });
    } catch (e) {
      stopIfDead();
      if (onResponse) onResponse(null);
    }
  }

  function listenRuntime(handler) {
    if (!runtimeAlive()) return;
    try {
      chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
        if (stopIfDead()) return;
        return handler(message, sender, sendResponse);
      });
    } catch (e) {
      stopIfDead();
    }
  }

  if (isCoach) {
    installCoachBridge();
  } else {
    installGameScraper();
  }

  function installCoachBridge() {
    listenRuntime(function (message) {
      if (!message || message.type !== 'blokee-from-extension') {
        return;
      }
      window.postMessage({ source: SOURCE, payload: message.payload }, '*');
    });

    window.addEventListener('message', function (event) {
      if (event.source !== window) return;
      var data = event.data;
      if (!data || data.source !== SOURCE) return;
      if (data.payload && data.payload.type === 'request-snapshot') {
        sendRuntime({ type: 'blokee-request-snapshot' });
      }
    });

    window.postMessage(
      {
        source: SOURCE,
        payload: {
          type: 'hello',
          version: 1,
          ts: Date.now(),
          source: 'blokee-extension',
        },
      },
      '*',
    );

    timers.push(
      setInterval(function () {
        if (stopIfDead()) return;
        window.postMessage(
          {
            source: SOURCE,
            payload: {
              type: 'ping',
              version: 1,
              ts: Date.now(),
              source: 'blokee-extension',
            },
          },
          '*',
        );
      }, 4000),
    );
  }

  function installGameScraper() {
    var BOARD_SIZE = 20;
    var POLL_MS = 400;
    var lastFingerprint = '';
    var forceNextSend = true;
    var lastDiag = '';

    function emptyBoard() {
      var board = [];
      for (var y = 0; y < BOARD_SIZE; y += 1) {
        var row = [];
        for (var x = 0; x < BOARD_SIZE; x += 1) row.push(null);
        board.push(row);
      }
      return board;
    }

    function mapColor(raw) {
      // Numeric ids follow mattle turn order: Blue → Green → Purple → Yellow
      if (raw === 0 || raw === '0') return 'blue';
      if (raw === 1 || raw === '1') return 'green';
      if (raw === 2 || raw === '2') return 'purple';
      if (raw === 3 || raw === '3') return 'yellow';
      if (!raw && raw !== 0) return null;
      var key = String(raw)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      if (!key || key === 'null' || key === 'none' || key === 'empty' || key === '-1') return null;
      if (key.indexOf('blue') !== -1 || key === 'b') return 'blue';
      if (
        key.indexOf('yellow') !== -1 ||
        key.indexOf('gold') !== -1 ||
        key.indexOf('orange') !== -1 ||
        key === 'y'
      ) {
        return 'yellow';
      }
      if (key.indexOf('green') !== -1 || key === 'g') return 'green';
      if (
        key.indexOf('red') !== -1 ||
        key.indexOf('purple') !== -1 ||
        key.indexOf('violet') !== -1 ||
        key.indexOf('pink') !== -1 ||
        key === 'r' ||
        key === 'p'
      ) {
        return 'purple';
      }
      return null;
    }

    function colorFromRgb(r, g, b, a) {
      if (a === undefined) a = 1;
      if (a < 0.15) return null;
      var sum = r + g + b;
      if (sum > 720 || sum < 45) return null;
      // Orange/amber yellow first (mattle yellow is often #cc6d00-like).
      if (r > 150 && r >= g && b < 100 && g < 210) return 'yellow';
      // True greens: G clearly dominant over R.
      if (g > r + 25 && g > b + 15 && g > 100) return 'green';
      if (b > r + 15 && b > g + 5 && b > 90) return 'blue';
      if (r > 120 && b > 120 && g < r && g < b && Math.abs(r - b) < 80) return 'purple';
      if (r > g + 35 && r > b + 35 && r > 140) return 'purple';
      return null;
    }

    /**
     * Map scraped hues onto seats (TL blue, TR yellow, BR purple, BL green).
     * Prefer corner ownership; fall back to nearest start-corner by centroid
     * so Anywhere openings (pieces not on corners) still remap green/yellow.
     */
    function remapBoardColorsByCorners(board) {
      var seats = [
        { seat: 'blue', x: 0, y: 0 },
        { seat: 'yellow', x: 19, y: 0 },
        { seat: 'purple', x: 19, y: 19 },
        { seat: 'green', x: 0, y: 19 },
      ];
      var allSeats = ['blue', 'yellow', 'purple', 'green'];
      var mapping = {};
      var usedSeats = {};

      for (var i = 0; i < seats.length; i += 1) {
        var scraped = board[seats[i].y][seats[i].x];
        if (scraped && !mapping[scraped] && !usedSeats[seats[i].seat]) {
          mapping[scraped] = seats[i].seat;
          usedSeats[seats[i].seat] = true;
        }
      }

      function cellsFor(color) {
        var cells = [];
        for (var y = 0; y < BOARD_SIZE; y += 1) {
          for (var x = 0; x < BOARD_SIZE; x += 1) {
            if (board[y][x] === color) cells.push({ x: x, y: y });
          }
        }
        return cells;
      }

      var present = [];
      for (var p = 0; p < allSeats.length; p += 1) {
        if (cellsFor(allSeats[p]).length > 0) present.push(allSeats[p]);
      }
      var unmapped = [];
      for (var u = 0; u < present.length; u += 1) {
        if (!mapping[present[u]]) unmapped.push(present[u]);
      }
      var unused = [];
      for (var s = 0; s < allSeats.length; s += 1) {
        if (!usedSeats[allSeats[s]]) unused.push(allSeats[s]);
      }

      if (unmapped.length > 0 && unused.length > 0) {
        var candidates = [];
        for (var c = 0; c < unmapped.length; c += 1) {
          var cells = cellsFor(unmapped[c]);
          var cx = 0;
          var cy = 0;
          for (var n = 0; n < cells.length; n += 1) {
            cx += cells[n].x;
            cy += cells[n].y;
          }
          cx /= cells.length;
          cy /= cells.length;
          for (var t = 0; t < unused.length; t += 1) {
            var corner = START_CORNERS_FOR(unused[t]);
            var dx = cx - corner.x;
            var dy = cy - corner.y;
            candidates.push({
              scraped: unmapped[c],
              seat: unused[t],
              score: dx * dx + dy * dy,
            });
          }
        }
        candidates.sort(function (a, b) {
          return a.score - b.score;
        });
        var claimedColor = {};
        var claimedSeat = {};
        for (var q = 0; q < candidates.length; q += 1) {
          var cand = candidates[q];
          if (claimedColor[cand.scraped] || claimedSeat[cand.seat]) continue;
          mapping[cand.scraped] = cand.seat;
          claimedColor[cand.scraped] = true;
          claimedSeat[cand.seat] = true;
        }
      }

      function START_CORNERS_FOR(seat) {
        if (seat === 'blue') return { x: 0, y: 0 };
        if (seat === 'yellow') return { x: 19, y: 0 };
        if (seat === 'purple') return { x: 19, y: 19 };
        return { x: 0, y: 19 };
      }

      var keys = Object.keys(mapping);
      if (keys.length === 0) return board;
      var seatCheck = {};
      for (var k = 0; k < keys.length; k += 1) {
        var seat = mapping[keys[k]];
        if (seatCheck[seat]) return board;
        seatCheck[seat] = true;
      }
      var remapped = emptyBoard();
      for (var y = 0; y < BOARD_SIZE; y += 1) {
        for (var x = 0; x < BOARD_SIZE; x += 1) {
          var cell = board[y][x];
          remapped[y][x] = cell ? mapping[cell] || cell : null;
        }
      }
      return remapped;
    }

    function colorFromComputed(el) {
      var style = getComputedStyle(el);
      var bg = style.backgroundColor || '';
      var match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/i);
      if (!match) return null;
      return colorFromRgb(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        match[4] === undefined ? 1 : Number(match[4]),
      );
    }

    function fingerprint(board, turn, pass) {
      var parts = [];
      var filled = 0;
      for (var y = 0; y < BOARD_SIZE; y += 1) {
        for (var x = 0; x < BOARD_SIZE; x += 1) {
          var cell = board[y][x];
          if (cell) {
            filled += 1;
            parts.push(x + ',' + y + ':' + cell);
          }
        }
      }
      return filled + '|' + (turn || '') + '|' + (pass || '') + '|' + parts.join(';');
    }

    function countFilled(board) {
      var n = 0;
      for (var y = 0; y < BOARD_SIZE; y += 1) {
        for (var x = 0; x < BOARD_SIZE; x += 1) {
          if (board[y][x]) n += 1;
        }
      }
      return n;
    }

    function isMattleHost() {
      return /mattle\.online$/i.test(location.hostname) || /blokee/i.test(location.hostname);
    }

    function normalizeCoord(value, zeroIndexedHint) {
      var n = Number(value);
      if (Number.isNaN(n)) return null;
      if (zeroIndexedHint) return n;
      if (n >= 1 && n <= BOARD_SIZE) return n - 1;
      return n;
    }

    function scrapeDomSquares() {
      var board = emptyBoard();
      var hits = 0;
      var candidates = document.querySelectorAll(
        [
          '[data-x][data-y]',
          '[id*="square_"]',
          '[id*="cell_"]',
          '.board-cell',
          '.board_cell',
          '.square[id]',
          '.blokus_square',
          '[class*="board-cell"]',
        ].join(','),
      );

      for (var i = 0; i < candidates.length; i += 1) {
        var el = candidates[i];
        var x;
        var y;
        if (el.hasAttribute('data-x') && el.hasAttribute('data-y')) {
          var rawX = Number(el.getAttribute('data-x'));
          var rawY = Number(el.getAttribute('data-y'));
          var zeroIndexed = rawX <= 19 && rawY <= 19 && (rawX === 0 || rawY === 0);
          x = normalizeCoord(rawX, zeroIndexed);
          y = normalizeCoord(rawY, zeroIndexed);
        } else {
          var idMatch = String(el.id).match(/(?:square|cell|board)[_-]?(\d+)[_-](\d+)/i);
          if (!idMatch) continue;
          var z =
            Number(idMatch[1]) <= 19 &&
            Number(idMatch[2]) <= 19 &&
            (Number(idMatch[1]) === 0 || Number(idMatch[2]) === 0);
          x = normalizeCoord(idMatch[1], z);
          y = normalizeCoord(idMatch[2], z);
        }
        if (x === null || y === null || x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) {
          continue;
        }

        var color = null;
        var names = ['blue', 'yellow', 'green', 'purple', 'red'];
        for (var n = 0; n < names.length; n += 1) {
          if (el.classList.contains(names[n])) {
            color = mapColor(names[n]);
            break;
          }
        }
        if (!color) color = mapColor(el.dataset.color);
        if (!color) color = mapColor(el.getAttribute('data-player'));
        if (!color) {
          for (var c = 0; c < el.classList.length; c += 1) {
            color = mapColor(el.classList[c]);
            if (color) break;
          }
        }
        if (!color && el.classList.contains('occupied')) color = colorFromComputed(el);
        if (!color) color = colorFromComputed(el);
        if (!color) continue;
        board[y][x] = color;
        hits += 1;
      }
      return hits > 0 ? board : null;
    }

    function sampleCanvas(canvas) {
      try {
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx || !canvas.width || !canvas.height) return null;
        var board = emptyBoard();
        var hits = 0;
        for (var y = 0; y < BOARD_SIZE; y += 1) {
          for (var x = 0; x < BOARD_SIZE; x += 1) {
            var cx = Math.floor(((x + 0.5) / BOARD_SIZE) * canvas.width);
            var cy = Math.floor(((y + 0.5) / BOARD_SIZE) * canvas.height);
            var size = Math.max(
              2,
              Math.floor(Math.min(canvas.width, canvas.height) / BOARD_SIZE / 4),
            );
            var x0 = Math.max(0, cx - size);
            var y0 = Math.max(0, cy - size);
            var w = Math.min(canvas.width - x0, size * 2);
            var h = Math.min(canvas.height - y0, size * 2);
            var data = ctx.getImageData(x0, y0, w, h).data;
            var r = 0;
            var g = 0;
            var b = 0;
            var a = 0;
            var n = 0;
            for (var i = 0; i < data.length; i += 4) {
              if (data[i + 3] < 40) continue;
              r += data[i];
              g += data[i + 1];
              b += data[i + 2];
              a += data[i + 3];
              n += 1;
            }
            if (n === 0) continue;
            var color = colorFromRgb(r / n, g / n, b / n, a / n / 255);
            if (color) {
              board[y][x] = color;
              hits += 1;
            }
          }
        }
        return hits > 0 ? { board: board, hits: hits } : null;
      } catch (e) {
        return null;
      }
    }

    function scrapeCanvases() {
      var canvases = document.querySelectorAll('canvas');
      var best = null;
      for (var i = 0; i < canvases.length; i += 1) {
        var canvas = canvases[i];
        var rect = canvas.getBoundingClientRect();
        if (rect.width < 140 || rect.height < 140) continue;
        var ratio = rect.width / rect.height;
        if (ratio < 0.7 || ratio > 1.4) continue;
        var sampled = sampleCanvas(canvas);
        if (!sampled) continue;
        if (!best || sampled.hits > best.hits) best = sampled;
      }
      return best ? best.board : null;
    }

    function scrapeActiveTurn() {
      var passColor = scrapePassColor();
      if (passColor) return passColor;
      var active = document.querySelector(
        [
          '.player-board.current-player',
          '.is_current_player',
          '.tray.active',
          '.piece-tray.active',
          '[class*="active"][class*="tray"]',
          '.current-turn',
        ].join(','),
      );
      if (!active) return undefined;
      var text = (active.className + ' ' + (active.textContent || '')).toLowerCase();
      if (text.indexOf('blue') !== -1) return 'blue';
      if (text.indexOf('yellow') !== -1) return 'yellow';
      if (text.indexOf('green') !== -1) return 'green';
      if (text.indexOf('red') !== -1 || text.indexOf('purple') !== -1) return 'purple';
      return undefined;
    }

    /** Pass lives in the seat that is to move. Prefer leaf text, then nearest corner. */
    function looksLikePassText(text) {
      var key = String(text || '')
        .replace(/\u2026/g, '...')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      return key === 'pass' || key === 'pass...' || (key.indexOf('pass') === 0 && key.length <= 12);
    }

    function seatFromPoint(x, y, w, h) {
      var left = x < w * 0.5;
      var top = y < h * 0.5;
      if (left && top) return 'blue';
      if (!left && top) return 'yellow';
      if (!left && !top) return 'purple';
      return 'green';
    }

    function scrapePassColor() {
      var w = window.innerWidth || 0;
      var h = window.innerHeight || 0;
      if (w < 100 || h < 100 || !document.body) return undefined;
      var hits = [];
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      var node = walker.nextNode();
      while (node) {
        if (looksLikePassText(node.nodeValue)) {
          var el = node.parentElement;
          if (el) {
            var rect = el.getBoundingClientRect();
            if (rect.width >= 8 && rect.height >= 8 && rect.width <= 520 && rect.height <= 140) {
              hits.push({
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                area: rect.width * rect.height,
              });
            }
          }
        }
        node = walker.nextNode();
      }
      var labeled = document.querySelectorAll(
        'button, [class*="pass"], [class*="Pass"], [id*="pass"], [id*="Pass"], [aria-label*="pass"], [aria-label*="Pass"]',
      );
      for (var i = 0; i < labeled.length; i += 1) {
        var label =
          (labeled[i].getAttribute('aria-label') || '') +
          ' ' +
          (labeled[i].className || '') +
          ' ' +
          (labeled[i].id || '');
        if (!looksLikePassText(labeled[i].textContent) && label.toLowerCase().indexOf('pass') === -1) {
          continue;
        }
        var box = labeled[i].getBoundingClientRect();
        if (box.width < 8 || box.height < 8 || box.width > 520 || box.height > 140) continue;
        hits.push({
          x: box.left + box.width / 2,
          y: box.top + box.height / 2,
          area: box.width * box.height,
        });
      }
      if (hits.length === 0) return undefined;
      hits.sort(function (a, b) {
        return a.area - b.area;
      });
      return seatFromPoint(hits[0].x, hits[0].y, w, h);
    }

    function requestPageGameStateFromBackground() {
      return new Promise(function (resolve) {
        sendRuntime({ type: 'blokee-read-page-state' }, function (response) {
          resolve(response && response.result ? response.result : null);
        });
      });
    }

    function normalizeImportedBoard(raw) {
      if (!raw) return null;
      if (Array.isArray(raw) && raw.length === BOARD_SIZE * BOARD_SIZE && !Array.isArray(raw[0])) {
        var flat = emptyBoard();
        var flatHits = 0;
        for (var i = 0; i < raw.length; i += 1) {
          var fx = i % BOARD_SIZE;
          var fy = Math.floor(i / BOARD_SIZE);
          var fcell = mapColor(raw[i]);
          if (fcell) {
            flat[fy][fx] = fcell;
            flatHits += 1;
          }
        }
        return flatHits > 0 ? flat : null;
      }
      if (!Array.isArray(raw) || raw.length !== BOARD_SIZE) return null;
      var board = emptyBoard();
      var hits = 0;
      for (var y = 0; y < BOARD_SIZE; y += 1) {
        if (!Array.isArray(raw[y]) || raw[y].length !== BOARD_SIZE) return null;
        for (var x = 0; x < BOARD_SIZE; x += 1) {
          var cell = mapColor(raw[y][x]);
          if (cell) {
            board[y][x] = cell;
            hits += 1;
          }
        }
      }
      return hits > 0 ? board : null;
    }

    function scrapeOnce() {
      return requestPageGameStateFromBackground().then(function (pageState) {
        var board = pageState ? normalizeImportedBoard(pageState.board) : null;
        var passColor =
          (pageState && mapColor(pageState.passColor)) || scrapePassColor() || undefined;
        var currentTurn =
          passColor ||
          (pageState ? mapColor(pageState.timerTurn) || mapColor(pageState.currentTurn) || undefined : undefined);
        if (!board) board = scrapeDomSquares();
        if (!board) board = scrapeCanvases();
        if (!currentTurn) currentTurn = scrapeActiveTurn();

        var canvasCount = document.querySelectorAll('canvas').length;
        var filled = board ? countFilled(board) : 0;
        lastDiag =
          'canvases=' +
          canvasCount +
          '; filled=' +
          filled +
          '; meteor=' +
          ((pageState && pageState.source) || 'none') +
          '; pass=' +
          (passColor || 'none');

        if (!board || filled === 0) return null;
        board = remapBoardColorsByCorners(board);
        return {
          type: 'board',
          version: 1,
          board: board,
          currentTurn: currentTurn,
          passColor: passColor,
          ts: Date.now(),
          source: isMattleHost() ? 'blokee.mattle.online' : location.hostname || 'game-tab',
        };
      });
    }

    function relay(payload) {
      sendRuntime({ type: 'blokee-relay', payload: payload });
    }

    function tick(force) {
      if (stopIfDead()) return;
      scrapeOnce()
        .then(function (payload) {
          if (stopIfDead()) return;
          if (!payload) {
            relay({
              type: 'ping',
              version: 1,
              ts: Date.now(),
              source: isMattleHost() ? 'blokee.mattle.online' : location.hostname || 'game-tab',
              detail: 'No board pixels yet (' + lastDiag + '). Keep the game room visible.',
            });
            return;
          }
          var fp = fingerprint(payload.board, payload.currentTurn, payload.passColor);
          if (!force && !forceNextSend && fp === lastFingerprint) {
            relay({
              type: 'ping',
              version: 1,
              ts: Date.now(),
              source: payload.source,
            });
            return;
          }
          forceNextSend = false;
          lastFingerprint = fp;
          relay(payload);
        })
        .catch(function (error) {
          console.debug('[Blokee Sync]', error);
        });
    }

    function shouldWatchPage() {
      if (isMattleHost()) return true;
      if (/boardgamearena\.com/i.test(location.href)) return true;
      if (/blokus|blokee/i.test(location.href)) return true;
      if (document.querySelector('canvas, .board-cell, .board, #board, .piece-tray, .tray')) {
        return true;
      }
      return false;
    }

    listenRuntime(function (message) {
      if (message && message.type === 'blokee-request-snapshot') {
        forceNextSend = true;
        tick(true);
      }
    });

    window.addEventListener('message', function (event) {
      if (event.source !== window) return;
      var data = event.data;
      if (!data || data.source !== SOURCE) return;
      if (data.payload && data.payload.type === 'request-snapshot') {
        forceNextSend = true;
        tick(true);
      }
    });

    function startPolling() {
      tick(true);
      timers.push(
        setInterval(function () {
          tick(false);
        }, POLL_MS),
      );
    }

    if (shouldWatchPage() || isMattleHost()) {
      startPolling();
    } else {
      timers.push(
        setTimeout(function () {
          if (shouldWatchPage()) {
            startPolling();
          }
        }, 1500),
      );
    }
  }
})();
