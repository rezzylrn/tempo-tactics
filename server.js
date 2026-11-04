// Tempo Tactics — small multiplayer turn-based strategy game.
// Zero-dependency Node.js server: JSON game API + static frontend.
// State lives in memory (with a best-effort JSON snapshot on disk).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'games.json');

const SIZE = 7;
const CENTER = { x: 3, y: 3 };
const BEACON_TARGET = 3;
const MAX_TURNS = 60;

const UNIT_TYPES = {
  vanguard: { hp: 4, move: 2, dmg: 2, label: 'Vanguard' },
  scout: { hp: 2, move: 3, dmg: 1, label: 'Scout' },
};

const PLAYER_COLORS = ['#e5484d', '#3e63dd', '#30a46c', '#f5a524'];
const CORNERS = [
  { x: 0, y: 0 },
  { x: 6, y: 6 },
  { x: 6, y: 0 },
  { x: 0, y: 6 },
];

function newId(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}
function newCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}
function inBounds(p) {
  return p.x >= 0 && p.x < SIZE && p.y >= 0 && p.y < SIZE;
}
function keyOf(p) {
  return p.x + ',' + p.y;
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

const games = new Map();

function createGame(numPlayers) {
  if (![2, 3, 4].includes(numPlayers)) throw new Error('numPlayers must be 2, 3 or 4');
  const id = newId(10);
  const game = {
    id,
    code: newCode(),
    status: 'lobby',
    numPlayers,
    players: [],
    units: [],
    currentPlayerId: null,
    turnCount: 0,
    roundNumber: 1,
    turnUnitId: null,
    winnerId: null,
    draw: false,
    winReason: null,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  games.set(id, game);
  logEvent(game, 'system', 'Game created. Waiting for ' + numPlayers + ' players.');
  save();
  return game;
}

function spawnUnits(game) {
  const units = [];
  game.players.forEach((player, pi) => {
    const corner = CORNERS[pi];
    const dx = corner.x === 0 ? 1 : -1;
    const dy = corner.y === 0 ? 1 : -1;
    const spots = [
      { type: 'vanguard', at: { x: corner.x, y: corner.y } },
      { type: 'scout', at: { x: corner.x + dx, y: corner.y } },
      { type: 'scout', at: { x: corner.x, y: corner.y + dy } },
    ];
    spots.forEach((s, i) => {
      units.push({
        id: player.id + '-u' + (i + 1),
        playerId: player.id,
        type: s.type,
        x: s.at.x,
        y: s.at.y,
        hp: UNIT_TYPES[s.type].hp,
        maxHp: UNIT_TYPES[s.type].hp,
      });
    });
  });
  game.units = units;
}

function joinGame(game, name, isBot) {
  if (game.status !== 'lobby') throw new Error('game already started');
  if (game.players.length >= game.numPlayers) throw new Error('game is full');
  const cleanName = String(name || '').trim().slice(0, 24) || ('Player ' + (game.players.length + 1));
  const player = {
    id: newId(8),
    name: cleanName,
    isBot: !!isBot,
    color: PLAYER_COLORS[game.players.length],
    alive: true,
    beaconPoints: 0,
  };
  game.players.push(player);
  logEvent(game, 'join', cleanName + ' joined the game.');
  save();
  return player;
}

function startGame(game, fillBots) {
  if (game.status !== 'lobby') throw new Error('game already started');
  if (fillBots) {
    while (game.players.length < game.numPlayers) {
      joinGame(game, 'Bot-' + (game.players.length + 1), true);
    }
  }
  if (game.players.length < game.numPlayers) {
    throw new Error('need ' + game.numPlayers + ' players to start');
  }
  spawnUnits(game);
  game.status = 'active';
  game.currentPlayerId = game.players[0].id;
  game.turnCount = 1;
  logEvent(game, 'start', 'Game started. ' + game.players[0].name + ' moves first.');
  save();
  return game;
}

function playerById(game, playerId) {
  return game.players.find((p) => p.id === playerId) || null;
}
function unitById(game, unitId) {
  return game.units.find((u) => u.id === unitId) || null;
}
function alivePlayers(game) {
  return game.players.filter((p) => p.alive);
}
function occupiedMap(game) {
  const map = new Map();
  for (const u of game.units) map.set(keyOf(u), u);
  return map;
}

// BFS reachable cells for a unit (8-directional, cannot pass through units).
function reachableCells(game, unit) {
  const range = UNIT_TYPES[unit.type].move;
  const occ = occupiedMap(game);
  const start = { x: unit.x, y: unit.y };
  const seen = new Map();
  seen.set(keyOf(start), 0);
  const queue = [start];
  const out = [];
  while (queue.length) {
    const cur = queue.shift();
    const dist = seen.get(keyOf(cur));
    if (dist >= range) continue;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nxt = { x: cur.x + dx, y: cur.y + dy };
        if (!inBounds(nxt)) continue;
        if (occ.has(keyOf(nxt))) continue;
        if (seen.has(keyOf(nxt))) continue;
        seen.set(keyOf(nxt), dist + 1);
        queue.push(nxt);
        out.push(nxt);
      }
    }
  }
  return out;
}

function attackableTargets(game, unit) {
  return game.units.filter(
    (u) => u.playerId !== unit.playerId && chebyshev(unit, u) <= 1
  );
}

function legalMoves(game, playerId, unitId) {
  const unit = unitById(game, unitId);
  if (!unit) throw new Error('unknown unit');
  if (unit.playerId !== playerId) throw new Error('unit belongs to another player');
  return {
    reachable: reachableCells(game, unit),
    attackable: attackableTargets(game, unit).map((u) => u.id),
  };
}

function assertTurn(game, playerId) {
  if (game.status !== 'active') throw new Error('game is not active');
  if (game.currentPlayerId !== playerId) throw new Error('not your turn');
  const player = playerById(game, playerId);
  if (!player || !player.alive) throw new Error('player is not alive in this game');
}

function assertActingUnit(game, playerId, unitId) {
  const unit = unitById(game, unitId);
  if (!unit) throw new Error('unknown unit');
  if (unit.playerId !== playerId) throw new Error('unit belongs to another player');
  if (game.turnUnitId && game.turnUnitId !== unitId) {
    throw new Error('another unit already acted this turn');
  }
  return unit;
}

function doMove(game, playerId, unitId, to) {
  assertTurn(game, playerId);
  const unit = assertActingUnit(game, playerId, unitId);
  if (!to || !inBounds(to)) throw new Error('destination out of bounds');
  const reach = reachableCells(game, unit);
  if (!reach.some((c) => c.x === to.x && c.y === to.y)) {
    throw new Error('destination not reachable');
  }
  unit.x = to.x;
  unit.y = to.y;
  game.turnUnitId = unitId;
  const player = playerById(game, playerId);
  logEvent(game, 'move', player.name + ' moved ' + UNIT_TYPES[unit.type].label + ' to (' + to.x + ',' + to.y + ').');
  game.updatedAt = new Date().toISOString();
  save();
  return game;
}

function doAttack(game, playerId, unitId, targetId) {
  assertTurn(game, playerId);
  const unit = assertActingUnit(game, playerId, unitId);
  const target = unitById(game, targetId);
  if (!target) throw new Error('unknown target');
  if (target.playerId === playerId) throw new Error('cannot attack your own unit');
  if (chebyshev(unit, target) > 1) throw new Error('target out of range');
  const dmg = UNIT_TYPES[unit.type].dmg;
  target.hp -= dmg;
  const attacker = playerById(game, playerId);
  const targetPlayer = playerById(game, target.playerId);
  let text = attacker.name + ' attacked ' + targetPlayer.name + "'s " +
    UNIT_TYPES[target.type].label + ' for ' + dmg + ' damage.';
  if (target.hp <= 0) {
    game.units = game.units.filter((u) => u.id !== target.id);
    text += ' Unit destroyed.';
  }
  logEvent(game, 'attack', text);
  game.updatedAt = new Date().toISOString();
  checkElimination(game);
  if (game.status === 'active') endTurnInternal(game);
  save();
  return game;
}

function endTurn(game, playerId) {
  assertTurn(game, playerId);
  endTurnInternal(game);
  game.updatedAt = new Date().toISOString();
  save();
  return game;
}

function endTurnInternal(game) {
  game.turnUnitId = null;
  const order = game.players;
  const curIdx = order.findIndex((p) => p.id === game.currentPlayerId);
  // Find next alive player in seating order (circular).
  let nextIdx = -1;
  for (let step = 1; step <= order.length; step++) {
    const idx = (curIdx + step) % order.length;
    if (order[idx].alive) {
      nextIdx = idx;
      break;
    }
  }
  if (nextIdx === -1) return; // nobody alive (should not happen)
  const wrapped = nextIdx <= curIdx;
  game.currentPlayerId = order[nextIdx].id;
  game.turnCount += 1;
  if (wrapped) {
    game.roundNumber += 1;
    checkBeacon(game);
    if (game.status !== 'active') return;
  }
  if (game.turnCount > MAX_TURNS) {
    finishByPoints(game);
    return;
  }
  const next = playerById(game, game.currentPlayerId);
  logEvent(game, 'turn', "Turn " + game.turnCount + ': ' + next.name + ' to move.');
}

function checkBeacon(game) {
  const holders = game.players.filter(
    (p) => p.alive && game.units.some((u) => u.playerId === p.id && u.x === CENTER.x && u.y === CENTER.y)
  );
  if (holders.length === 1) {
    const holder = holders[0];
    holder.beaconPoints += 1;
    logEvent(game, 'beacon', holder.name + ' holds the beacon. Beacon points: ' + holder.beaconPoints + '/' + BEACON_TARGET + '.');
    if (holder.beaconPoints >= BEACON_TARGET) {
      finishGame(game, holder.id, 'beacon');
    }
  } else if (holders.length > 1) {
    logEvent(game, 'beacon', 'Beacon contested, no point awarded.');
  }
}

function checkElimination(game) {
  for (const p of game.players) {
    if (p.alive && !game.units.some((u) => u.playerId === p.id)) {
      p.alive = false;
      logEvent(game, 'eliminated', p.name + ' has no units left and is eliminated.');
    }
  }
  const alive = alivePlayers(game);
  if (alive.length === 1) {
    finishGame(game, alive[0].id, 'elimination');
  }
}

function finishByPoints(game) {
  const alive = alivePlayers(game);
  const ranked = [...alive].sort((a, b) => {
    if (b.beaconPoints !== a.beaconPoints) return b.beaconPoints - a.beaconPoints;
    const unitsA = game.units.filter((u) => u.playerId === a.id).length;
    const unitsB = game.units.filter((u) => u.playerId === b.id).length;
    if (unitsB !== unitsA) return unitsB - unitsA;
    const hpA = game.units.filter((u) => u.playerId === a.id).reduce((s, u) => s + u.hp, 0);
    const hpB = game.units.filter((u) => u.playerId === b.id).reduce((s, u) => s + u.hp, 0);
    return hpB - hpA;
  });
  const top = ranked[0];
  const second = ranked[1];
  const topUnits = game.units.filter((u) => u.playerId === top.id).length;
  const topHp = game.units.filter((u) => u.playerId === top.id).reduce((s, u) => s + u.hp, 0);
  const secondUnits = second ? game.units.filter((u) => u.playerId === second.id).length : -1;
  const secondHp = second ? game.units.filter((u) => u.playerId === second.id).reduce((s, u) => s + u.hp, 0) : -1;
  if (second && top.beaconPoints === second.beaconPoints && topUnits === secondUnits && topHp === secondHp) {
    game.status = 'finished';
    game.draw = true;
    game.winReason = 'time';
    logEvent(game, 'end', 'Turn limit reached. The match is a draw.');
  } else {
    finishGame(game, top.id, 'time');
  }
}

function finishGame(game, winnerId, reason) {
  game.status = 'finished';
  game.winnerId = winnerId;
  game.winReason = reason;
  const winner = playerById(game, winnerId);
  const reasonText = reason === 'beacon'
    ? ' by holding the beacon 3 times'
    : reason === 'elimination'
      ? ' by eliminating all rivals'
      : ' on points at the turn limit';
  logEvent(game, 'end', (winner ? winner.name : 'Nobody') + ' wins' + reasonText + '.');
}

function logEvent(game, type, text) {
  game.log.push({
    seq: game.log.length + 1,
    turn: game.turnCount,
    round: game.roundNumber,
    type,
    text,
    at: new Date().toISOString(),
    snapshot: {
      units: game.units.map((u) => ({ ...u })),
      points: game.players.map((p) => ({ id: p.id, pts: p.beaconPoints, alive: p.alive })),
      currentPlayerId: game.currentPlayerId,
    },
  });
  if (game.log.length > 400) game.log = game.log.slice(-400);
}

// ---------------------------------------------------------------------------
// Bot (heuristic): prefers kills, then beacon control, then hunting.
// ---------------------------------------------------------------------------

function botChoose(game, playerId) {
  const myUnits = game.units.filter((u) => u.playerId === playerId);
  if (!myUnits.length) return { pass: true };
  let best = null; // {score, unitId, to, attackTargetId}
  const consider = (score, unitId, to, attackTargetId) => {
    if (!best || score > best.score) best = { score, unitId, to, attackTargetId };
  };
  for (const unit of myUnits) {
    // Immediate attacks from current position.
    for (const target of attackableTargets(game, unit)) {
      const kill = target.hp <= UNIT_TYPES[unit.type].dmg;
      const score = UNIT_TYPES[unit.type].dmg * 10 + (kill ? 60 : 0) + (target.type === 'vanguard' ? 5 : 0);
      consider(score, unit.id, null, target.id);
    }
    // Moves.
    for (const cell of reachableCells(game, unit)) {
      let score = -chebyshev(cell, CENTER) * 2;
      if (cell.x === CENTER.x && cell.y === CENTER.y) score += 45 + (unit.type === 'scout' ? 10 : 0);
      // After moving here, could we attack?
      const moved = { ...unit, x: cell.x, y: cell.y };
      const foes = game.units.filter(
        (u) => u.playerId !== playerId && chebyshev(moved, u) <= 1
      );
      let attackTargetId = null;
      if (foes.length) {
        const t = foes.sort((a, b) => a.hp - b.hp)[0];
        const kill = t.hp <= UNIT_TYPES[unit.type].dmg;
        score += UNIT_TYPES[unit.type].dmg * 8 + (kill ? 45 : 0);
        attackTargetId = t.id;
      } else {
        // Drift toward the nearest enemy.
        let nearest = 99;
        for (const u of game.units) {
          if (u.playerId === playerId) continue;
          nearest = Math.min(nearest, chebyshev(cell, u));
        }
        if (nearest < 99) score -= nearest;
      }
      consider(score, unit.id, cell, attackTargetId);
    }
  }
  if (!best) return { pass: true };
  return best;
}

function botPlay(game, playerId) {
  if (game.status !== 'active') throw new Error('game is not active');
  const currentId = playerId || game.currentPlayerId;
  if (game.currentPlayerId !== currentId) throw new Error('not that player turn');
  const player = playerById(game, currentId);
  if (!player) throw new Error('unknown player');
  if (playerId && !player.isBot) {
    // Allow forcing a bot move only for bot seats; humans use the UI/API.
    throw new Error('bot move is only for bot players');
  }
  const choice = botChoose(game, currentId);
  if (choice.pass) {
    endTurnInternal(game);
    game.updatedAt = new Date().toISOString();
    save();
    return { action: 'pass', state: publicState(game) };
  }
  const unit = unitById(game, choice.unitId);
  if (choice.to) doMove(game, currentId, choice.unitId, choice.to);
  if (game.status !== 'active') return { action: 'move', state: publicState(game) };
  if (choice.attackTargetId) {
    // Target may have moved out of range only if we did not move; re-check.
    const target = unitById(game, choice.attackTargetId);
    if (target && chebyshev(unit, target) <= 1) {
      doAttack(game, currentId, choice.unitId, choice.attackTargetId);
      return { action: 'move-attack', state: publicState(game) };
    }
  }
  endTurnInternal(game);
  game.updatedAt = new Date().toISOString();
  save();
  return { action: choice.to ? 'move' : 'attack', state: publicState(game) };
}

// ---------------------------------------------------------------------------
// Public state + persistence
// ---------------------------------------------------------------------------

function publicState(game) {
  return {
    id: game.id,
    code: game.code,
    status: game.status,
    numPlayers: game.numPlayers,
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      color: p.color,
      alive: p.alive,
      beaconPoints: p.beaconPoints,
    })),
    units: game.units.map((u) => ({ ...u })),
    currentPlayerId: game.currentPlayerId,
    turnCount: game.turnCount,
    roundNumber: game.roundNumber,
    turnUnitId: game.turnUnitId,
    winnerId: game.winnerId,
    draw: game.draw,
    winReason: game.winReason,
    beaconTarget: BEACON_TARGET,
    maxTurns: MAX_TURNS,
    boardSize: SIZE,
    log: game.log.slice(-30),
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
  };
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify([...games.values()], null, 2));
  } catch (e) {
    // Best-effort only; memory is the source of truth.
  }
}

function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const g of arr) games.set(g.id, g);
  } catch (e) {
    // Corrupt or missing snapshot: start fresh.
  }
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(__dirname, 'public', rel);
  const root = path.join(__dirname, 'public');
  if (!file.startsWith(root)) return sendText(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return sendText(res, 404, 'not found');
    const ext = path.extname(file);
    sendText(res, 200, data, MIME[ext] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    // Health
    if (pathname === '/healthz' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, games: games.size });
    }

    // API: list games
    if (pathname === '/api/games' && req.method === 'GET') {
      const list = [...games.values()].map((g) => ({
        id: g.id,
        code: g.code,
        status: g.status,
        numPlayers: g.numPlayers,
        players: g.players.map((p) => p.name),
        currentPlayerId: g.currentPlayerId,
        turnCount: g.turnCount,
        createdAt: g.createdAt,
      }));
      return sendJson(res, 200, { games: list });
    }

    // API: create game
    if (pathname === '/api/games' && req.method === 'POST') {
      const body = await readBody(req);
      const game = createGame(Number(body.numPlayers) || 2);
      return sendJson(res, 201, publicState(game));
    }

    const m = pathname.match(/^\/api\/games\/([A-Za-z0-9_-]+)(?:\/(join|start|move|attack|end-turn|bot|log|legal-moves))?$/);
    if (m) {
      const game = games.get(m[1]);
      if (!game) return sendJson(res, 404, { error: 'game_not_found' });
      const action = m[2];

      if (!action && req.method === 'GET') {
        return sendJson(res, 200, publicState(game));
      }
      if (action === 'log' && req.method === 'GET') {
        return sendJson(res, 200, {
          id: game.id,
          status: game.status,
          winnerId: game.winnerId,
          draw: game.draw,
          winReason: game.winReason,
          log: game.log,
        });
      }
      if (action === 'legal-moves' && req.method === 'GET') {
        const playerId = url.searchParams.get('playerId');
        const unitId = url.searchParams.get('unitId');
        if (!playerId || !unitId) {
          return sendJson(res, 400, { error: 'playerId and unitId query params are required' });
        }
        const moves = legalMoves(game, playerId, unitId);
        return sendJson(res, 200, moves);
      }
      if (action === 'join' && req.method === 'POST') {
        const body = await readBody(req);
        const player = joinGame(game, body.name, body.bot);
        return sendJson(res, 201, { player, state: publicState(game) });
      }
      if (action === 'start' && req.method === 'POST') {
        const body = await readBody(req);
        startGame(game, !!body.fillBots);
        return sendJson(res, 200, publicState(game));
      }
      if (action === 'move' && req.method === 'POST') {
        const body = await readBody(req);
        doMove(game, body.playerId, body.unitId, body.to);
        return sendJson(res, 200, publicState(game));
      }
      if (action === 'attack' && req.method === 'POST') {
        const body = await readBody(req);
        doAttack(game, body.playerId, body.unitId, body.targetId);
        return sendJson(res, 200, publicState(game));
      }
      if (action === 'end-turn' && req.method === 'POST') {
        const body = await readBody(req);
        endTurn(game, body.playerId);
        return sendJson(res, 200, publicState(game));
      }
      if (action === 'bot' && req.method === 'POST') {
        const body = await readBody(req);
        const result = botPlay(game, body.playerId || null);
        return sendJson(res, 200, result);
      }
      return sendJson(res, 404, { error: 'unknown_action' });
    }

    // Static frontend
    if (req.method === 'GET') return serveStatic(req, res, pathname);
    return sendJson(res, 404, { error: 'not_found' });
  } catch (e) {
    return sendJson(res, 400, { error: e.message || 'bad request' });
  }
});

load();
server.listen(PORT, () => {
  console.log('Tempo Tactics listening on port ' + PORT);
});
