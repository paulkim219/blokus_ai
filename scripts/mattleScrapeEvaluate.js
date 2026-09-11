/**
 * Runs inside the mattle page (Playwright page.evaluate string).
 * Keep this file free of TypeScript / named function declarations so tsx
 * cannot inject a `__name` helper that does not exist in the browser.
 */
(() => {
  const SIZE = 20;
  const playerIndexToColor = ['blue', 'green', 'purple', 'yellow'];

  const looksLikeBoard = (value) => {
    if (!Array.isArray(value)) return false;
    if (value.length === SIZE && Array.isArray(value[0]) && value[0].length === SIZE) return true;
    return value.length === SIZE * SIZE && !Array.isArray(value[0]);
  };

  const findBoard = (value, depth) => {
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
      for (const item of Object.values(value)) {
        const found = findBoard(item, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  const normalizeBoard = (raw) => {
    if (!Array.isArray(raw)) return null;
    const board = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => null));
    if (raw.length === SIZE && Array.isArray(raw[0])) {
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const cell = raw[y][x];
          board[y][x] = cell == null || cell === '' || cell === -1 ? null : String(cell);
        }
      }
      return board;
    }
    return null;
  };

  const colorFromRgb = (r, g, b, a) => {
    if (a === undefined) a = 1;
    if (a < 0.15) return null;
    const sum = r + g + b;
    if (sum > 720 || sum < 45) return null;
    if (r > 150 && r >= g && b < 100 && g < 210) return 'yellow';
    if (g > r + 25 && g > b + 15 && g > 100) return 'green';
    if (b > r + 15 && b > g + 5 && b > 90) return 'blue';
    if (r > 120 && b > 120 && g < r && g < b && Math.abs(r - b) < 80) return 'purple';
    if (r > g + 35 && r > b + 35 && r > 140) return 'purple';
    return null;
  };

  const countRecognized = (board) => {
    if (!board) return 0;
    let n = 0;
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        if (colorFromUnknown(board[y][x])) n += 1;
      }
    }
    return n;
  };

  const sampleCanvas = (canvas) => {
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx || !canvas.width || !canvas.height) return null;
      const board = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => null));
      let hits = 0;
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const cx = Math.floor(((x + 0.5) / SIZE) * canvas.width);
          const cy = Math.floor(((y + 0.5) / SIZE) * canvas.height);
          const size = Math.max(2, Math.floor(Math.min(canvas.width, canvas.height) / SIZE / 4));
          const x0 = Math.max(0, cx - size);
          const y0 = Math.max(0, cy - size);
          const w = Math.min(canvas.width - x0, size * 2);
          const h = Math.min(canvas.height - y0, size * 2);
          const data = ctx.getImageData(x0, y0, w, h).data;
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          let n = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 40) continue;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            a += data[i + 3];
            n += 1;
          }
          if (n === 0) continue;
          const color = colorFromRgb(r / n, g / n, b / n, a / n / 255);
          if (color) {
            board[y][x] = color;
            hits += 1;
          }
        }
      }
      return hits > 0 ? board : null;
    } catch {
      return null;
    }
  };

  const scrapeCanvases = () => {
    const canvases = document.querySelectorAll('canvas');
    let best = null;
    let bestHits = 0;
    for (let i = 0; i < canvases.length; i += 1) {
      const rect = canvases[i].getBoundingClientRect();
      if (rect.width < 140 || rect.height < 140) continue;
      const ratio = rect.width / rect.height;
      if (ratio < 0.7 || ratio > 1.4) continue;
      const board = sampleCanvas(canvases[i]);
      const hits = countRecognized(board);
      if (hits > bestHits) {
        best = board;
        bestHits = hits;
      }
    }
    return best;
  };

  const looksLikePassText = (text) => {
    const key = text.replace(/\s+/g, ' ').trim().toLowerCase();
    return key === 'pass' || (key.startsWith('pass') && key.length <= 12);
  };

  const colorFromIndex = (index) => {
    if (!Number.isFinite(index)) return null;
    return playerIndexToColor[index] || null;
  };

  const colorFromUnknown = (value) => {
    if (value == null) return null;
    if (typeof value === 'number') return colorFromIndex(value);
    const key = String(value).trim().toLowerCase();
    if (key === '0' || key === 'blue' || key === 'b') return 'blue';
    if (key === '1' || key === 'green' || key === 'g') return 'green';
    if (key === '2' || key === 'purple' || key === 'red' || key === 'p' || key === 'r') return 'purple';
    if (key === '3' || key === 'yellow' || key === 'y' || key === 'orange' || key === 'gold') {
      return 'yellow';
    }
    return null;
  };

  const looksLikeMeteorId = (value) => {
    if (value == null) return false;
    const text = String(value);
    if (/^\d{1,2}$/.test(text)) return false;
    return text.length >= 8;
  };

  const playerUserId = (player) => {
    const candidates = [player.userId, player.uid, player.user_id];
    for (const value of candidates) {
      if (looksLikeMeteorId(value)) return String(value);
    }
    if (typeof player.id === 'string' && looksLikeMeteorId(player.id)) return player.id;
    if (typeof player._id === 'string' && looksLikeMeteorId(player._id)) return player._id;
    return null;
  };

  const isBotLike = (player) => {
    if (!player || typeof player !== 'object') return false;
    const flags = [
      player.isAI,
      player.isAi,
      player.ai,
      player.AI,
      player.isCpu,
      player.isCPU,
      player.cpu,
      player.CPU,
      player.isBot,
      player.bot,
      player.robot,
      player.isRobot,
      player.computer,
      player.robotLevel,
      player.aiLevel,
    ];
    if (flags.some((flag) => flag === true || flag === 1 || flag === '1')) return true;
    const type = String(player.type || player.playerType || player.kind || player.role || '').toLowerCase();
    if (/\b(cpu|bot|ai|computer|robot)\b/.test(type)) return true;
    const name = String(player.name || player.username || player.displayName || '').toLowerCase();
    return /\b(cpu|bot|ai|computer)\b/.test(name);
  };

  const seatFromPlayer = (player, fallbackIndex) => {
    if (!player || typeof player !== 'object') return null;
    const index = Number(
      player.playerIndex ?? player.index ?? player.colorIndex ?? player.seat ?? fallbackIndex,
    );
    const color =
      colorFromUnknown(player.color) ||
      colorFromUnknown(player.colour) ||
      colorFromIndex(index);
    if (!color) return null;
    return {
      color,
      index: Number.isFinite(index) ? index : playerIndexToColor.indexOf(color),
      name: player.name || player.username || player.displayName || null,
      userId: playerUserId(player),
      isBot: isBotLike(player),
    };
  };

  const collectDomSeats = () => {
    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    if (w < 100 || h < 100) return [];
    const bandX = w * 0.34;
    const bandY = h * 0.34;
    const regions = [
      { color: 'blue', left: 0, top: 0, right: bandX, bottom: bandY },
      { color: 'yellow', left: w - bandX, top: 0, right: w, bottom: bandY },
      { color: 'purple', left: w - bandX, top: h - bandY, right: w, bottom: h },
      { color: 'green', left: 0, top: h - bandY, right: bandX, bottom: h },
    ];
    const inRegion = (x, y, region) =>
      x >= region.left && x <= region.right && y >= region.top && y <= region.bottom;
    const trayCenters = [
      { color: 'blue', x: w * 0.12, y: h * 0.22 },
      { color: 'yellow', x: w * 0.88, y: h * 0.22 },
      { color: 'purple', x: w * 0.88, y: h * 0.78 },
      { color: 'green', x: w * 0.12, y: h * 0.78 },
    ];
    const nearestTray = (x, y) => {
      let best = trayCenters[0];
      let bestDist = Infinity;
      for (let i = 0; i < trayCenters.length; i += 1) {
        const dx = x - trayCenters[i].x;
        const dy = y - trayCenters[i].y;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          best = trayCenters[i];
          bestDist = dist;
        }
      }
      return best.color;
    };

    const headerBottom = h * 0.14;
    const passPoints = [];
    const nodes = document.querySelectorAll('div, span, p, button, a, label, h1, h2, h3, li, strong');
    for (let i = 0; i < nodes.length; i += 1) {
      const text = (nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (!looksLikePassText(text)) continue;
      const rect = nodes[i].getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8 || rect.width > 520 || rect.height > 120) continue;
      passPoints.push({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        area: rect.width * rect.height,
      });
    }
    passPoints.sort((a, b) => a.area - b.area);
    const passColor = passPoints.length > 0 ? nearestTray(passPoints[0].x, passPoints[0].y) : null;

    let timerTurn = null;
    for (let i = 0; i < nodes.length; i += 1) {
      const text = (nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length > 24) continue;
      const match = text.match(/\b(\d{1,2}):(\d{2})\b/);
      if (!match) continue;
      if (match[0] === '10:00') continue;
      const rect = nodes[i].getBoundingClientRect();
      if (rect.height > 40 || rect.width > 120) continue;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cy > headerBottom) continue;
      const slot = Math.min(3, Math.max(0, Math.floor((cx / w) * 4)));
      timerTurn = playerIndexToColor[slot];
      break;
    }

    return {
      seats: regions.map((region) => {
      let name = null;
      let sawCpu = false;
      const hasPass = passColor === region.color;
      const limit = Math.min(nodes.length, 2800);
      for (let i = 0; i < limit; i += 1) {
        const rect = nodes[i].getBoundingClientRect();
        if (rect.width < 6 || rect.height < 6) continue;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        if (!inRegion(cx, cy, region)) continue;
        if (cy < headerBottom) continue;
        const text = (nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 64) continue;
        if (/\bCPU\b/i.test(text) && text.length < 48) sawCpu = true;
        const guest = text.match(/\bguest\d+\b/i);
        if (guest) name = guest[0];
      }
      return {
        color: region.color,
        name,
        isBot: hasPass ? false : sawCpu,
        hasPass,
        isActive: hasPass || timerTurn === region.color,
      };
    }),
      timerTurn,
    };
  };

  let userId = null;
  let username = null;
  try {
    if (typeof Meteor !== 'undefined' && Meteor) {
      if (typeof Meteor.userId === 'function') userId = Meteor.userId() || null;
      if (typeof Meteor.user === 'function') {
        const user = Meteor.user();
        username = (user && (user.username || user.profile && user.profile.name)) || null;
      }
    }
  } catch {
    userId = null;
  }

  const dom = collectDomSeats();
  const domSeats = dom.seats;
  const passSeat = domSeats.find((seat) => seat.hasPass);
  const timerTurn = dom.timerTurn;

  try {
    if (typeof Games !== 'undefined' && Games && typeof Games.find === 'function') {
      const games = Games.find({}, { sort: { updatedAt: -1 } }).fetch();
      for (const game of games) {
        if (!game) continue;
        const meteorBoard = normalizeBoard(findBoard(game.data) || findBoard(game));
        const canvasBoard = scrapeCanvases();
        const meteorHits = countRecognized(meteorBoard);
        const canvasHits = countRecognized(canvasBoard);
        let board = null;
        if (canvasHits > meteorHits) board = canvasBoard;
        else if (meteorHits > 0) board = meteorBoard;
        else if (canvasHits > 0) board = canvasBoard;
        let currentTurn = null;
        if (Array.isArray(game.activeStatuses)) {
          const active = game.activeStatuses.find((entry) => entry && entry.isActive);
          if (active) currentTurn = colorFromIndex(active.playerIndex);
        }
        if (!currentTurn && Number.isFinite(game.currentPlayerIndex)) {
          currentTurn = colorFromIndex(game.currentPlayerIndex);
        }
        if (passSeat) currentTurn = passSeat.color;
        else if (timerTurn) currentTurn = timerTurn;

        const seatSources = [
          game.players,
          game.playerStatuses,
          game.users,
          game.data && game.data.players,
          game.activeStatuses,
        ].find((value) => Array.isArray(value) && value.length > 0);

        const seats = [];
        if (seatSources) {
          for (let i = 0; i < seatSources.length; i += 1) {
            const seat = seatFromPlayer(seatSources[i], i);
            if (seat) seats.push(seat);
          }
        }

        return {
          board,
          currentTurn,
          source: board ? 'meteor-Games' : 'meteor-Games-empty',
          userId,
          username,
          seats,
          domSeats,
          status: game.status || null,
          gameKeys: Object.keys(game),
        };
      }
    }
  } catch (error) {
    return {
      board: null,
      currentTurn: passSeat ? passSeat.color : timerTurn,
      source: 'meteor-error',
      userId,
      username,
      seats: [],
      domSeats,
      status: String(error),
      gameKeys: [],
    };
  }

  const canvasBoard = scrapeCanvases();
  return {
    board: canvasBoard,
    currentTurn: passSeat ? passSeat.color : timerTurn,
    source: canvasBoard ? 'canvas' : 'none',
    userId,
    username,
    seats: [],
    domSeats,
    status: null,
    gameKeys: [],
  };
})()
