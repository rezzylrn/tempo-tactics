// Tempo Tactics — browser client.
// Talks only to the JSON API documented in README.md.

const api = {
  async get(path) {
    const r = await fetch(path);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  },
};

const $ = (id) => document.getElementById(id);

let game = null;          // latest public state
let myPlayerId = null;    // my seat in this game
let selectedUnit = null;  // unit id selected in the UI
let legal = null;         // {reachable, attackable} for selected unit
let pollTimer = null;
let replayLog = [];       // full log entries with snapshots
let replayIndex = -1;     // -1 = live
let botInFlight = false;

function show(el, on) { el.classList.toggle('hidden', !on); }

function toast(msg) {
  const hint = $('turnHint');
  hint.textContent = msg;
}

// ---------------- Lobby ----------------

async function refreshGameList() {
  try {
    const { games } = await api.get('/api/games');
    const list = $('gameList');
    const open = games.filter((g) => g.status === 'lobby');
    if (!open.length) {
      list.innerHTML = '<p class="hint">No open games right now — create one.</p>';
      return;
    }
    list.innerHTML = '';
    for (const g of open) {
      const row = document.createElement('div');
      row.className = 'game-row';
      row.innerHTML = '<span><span class="code">' + g.code + '</span> — ' +
        g.players.join(', ') + ' (' + g.players.length + '/' + g.numPlayers + ')</span>';
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = 'Join';
      btn.onclick = () => {
        $('joinCode').value = g.code;
        $('joinName').focus();
      };
      row.appendChild(btn);
      list.appendChild(row);
    }
  } catch (e) {
    $('gameList').innerHTML = '<p class="hint">Could not load games.</p>';
  }
}

async function createGame() {
  const numPlayers = Number($('numPlayers').value);
  const name = $('hostName').value.trim() || 'Player 1';
  try {
    const state = await api.post('/api/games', { numPlayers });
    const joined = await api.post('/api/games/' + state.id + '/join', { name });
    enterGame(joined.state, joined.player.id);
  } catch (e) {
    alert('Could not create game: ' + e.message);
  }
}

async function joinGame() {
  const code = $('joinCode').value.trim().toUpperCase();
  const name = $('joinName').value.trim() || 'Player 2';
  if (!code) return alert('Enter a game code.');
  try {
    const { games } = await api.get('/api/games');
    const target = games.find((g) => g.code === code);
    if (!target) return alert('No game with that code.');
    const joined = await api.post('/api/games/' + target.id + '/join', { name });
    enterGame(joined.state, joined.player.id);
  } catch (e) {
    alert('Could not join game: ' + e.message);
  }
}

async function quickGame() {
  try {
    const state = await api.post('/api/games', { numPlayers: 2 });
    const joined = await api.post('/api/games/' + state.id + '/join', { name: 'You' });
    await api.post('/api/games/' + state.id + '/start', { fillBots: true });
    const fresh = await api.get('/api/games/' + state.id);
    enterGame(fresh, joined.player.id);
  } catch (e) {
    alert('Could not start quick game: ' + e.message);
  }
}

// ---------------- Game view ----------------

function enterGame(state, playerId) {
  game = state;
  myPlayerId = playerId;
  selectedUnit = null;
  legal = null;
  replayIndex = -1;
  replayLog = [];
  show($('lobby'), false);
  show($('game'), true);
  $('gameCode').textContent = state.code;
  ensureLobbyButtons();
  render();
  loadReplayLog();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, 1500);
}

function leaveGame() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  game = null;
  myPlayerId = null;
  show($('game'), false);
  show($('lobby'), true);
  refreshGameList();
}

function ensureLobbyButtons() {
  const actions = document.querySelector('.game-actions');
  if (!$('btnAddBot')) {
    const b = document.createElement('button');
    b.id = 'btnAddBot';
    b.className = 'btn';
    b.textContent = 'Add bot';
    b.onclick = addBot;
    actions.appendChild(b);
  }
  if (!$('btnStart')) {
    const b = document.createElement('button');
    b.id = 'btnStart';
    b.className = 'btn accent';
    b.textContent = 'Start game';
    b.onclick = startGame;
    actions.appendChild(b);
  }
}

async function addBot() {
  try {
    const joined = await api.post('/api/games/' + game.id + '/join', {
      name: 'Bot-' + (game.players.length + 1),
      bot: true,
    });
    game = joined.state;
    render();
  } catch (e) {
    alert('Could not add bot: ' + e.message);
  }
}

async function startGame() {
  try {
    game = await api.post('/api/games/' + game.id + '/start', { fillBots: true });
    render();
  } catch (e) {
    alert('Could not start: ' + e.message);
  }
}

async function loadReplayLog() {
  try {
    const data = await api.get('/api/games/' + game.id + '/log');
    replayLog = data.log || [];
    const range = $('replayRange');
    range.max = Math.max(0, replayLog.length - 1);
    range.value = replayLog.length - 1;
    updateReplayLabel();
  } catch (e) {
    // Replay is optional; the live board still works.
  }
}

function updateReplayLabel() {
  const range = $('replayRange');
  $('replayLabel').textContent = replayIndex < 0
    ? 'live'
    : 'event ' + (Number(range.value) + 1) + ' / ' + replayLog.length;
}

async function poll() {
  if (!game) return;
  try {
    const fresh = await api.get('/api/games/' + game.id);
    const wasTurn = game.turnCount;
    game = fresh;
    render();
    if (game.status === 'finished') {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      loadReplayLog();
      return;
    }
    // Auto-play bot turns.
    const current = game.players.find((p) => p.id === game.currentPlayerId);
    if (current && current.isBot && !botInFlight) {
      botInFlight = true;
      setTimeout(async () => {
        try {
          const result = await api.post('/api/games/' + game.id + '/bot', {});
          game = result.state;
          render();
        } catch (e) {
          // Bot failure is non-fatal; the next poll retries.
        } finally {
          botInFlight = false;
        }
      }, 700);
    }
    if (game.turnCount !== wasTurn) loadReplayLog();
  } catch (e) {
    // Transient network error: keep polling.
  }
}

function myTurn() {
  return game && game.status === 'active' && game.currentPlayerId === myPlayerId;
}

function render() {
  if (!game) return;
  const inLobby = game.status === 'lobby';
  show($('btnAddBot'), inLobby);
  show($('btnStart'), inLobby);
  show($('btnEndTurn'), game.status === 'active');

  // Status line.
  let status = '';
  if (inLobby) {
    status = 'Lobby — ' + game.players.length + '/' + game.numPlayers +
      ' players. Add bots or wait for friends, then start.';
  } else if (game.status === 'active') {
    const current = game.players.find((p) => p.id === game.currentPlayerId);
    status = 'Round ' + game.roundNumber + ' — turn ' + game.turnCount + ' of ' + game.maxTurns +
      '. ' + (current ? current.name + ' to move.' : '');
  } else {
    status = 'Finished.';
  }
  $('gameStatus').textContent = status;

  // Banner.
  const banner = $('banner');
  if (game.status === 'finished') {
    const winner = game.players.find((p) => p.id === game.winnerId);
    const reason = game.winReason === 'beacon'
      ? ' by holding the beacon 3 times'
      : game.winReason === 'elimination'
        ? ' by eliminating all rivals'
        : ' on points at the turn limit';
    banner.textContent = game.draw
      ? 'Draw — turn limit reached with no winner.'
      : (winner ? winner.name : 'Nobody') + ' wins' + reason + '.';
    show(banner, true);
  } else {
    show(banner, false);
  }

  renderBoard();
  renderPlayers();
  renderLog();
  updateTurnHint();
}

function renderBoard() {
  const board = $('board');
  const snap = replayIndex >= 0 && replayLog[replayIndex]
    ? replayLog[replayIndex].snapshot
    : null;
  const units = snap ? snap.units : game.units;
  const unitAt = new Map(units.map((u) => [u.x + ',' + u.y, u]));
  const playerByIdMap = new Map(game.players.map((p) => [p.id, p]));

  board.innerHTML = '';
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const cell = document.createElement('div');
      cell.className = 'cell' + (((x + y) % 2 === 0) ? ' alt' : '');
      if (x === 3 && y === 3) cell.classList.add('beacon');
      cell.dataset.x = x;
      cell.dataset.y = y;
      const unit = unitAt.get(x + ',' + y);
      if (unit) {
        const player = playerByIdMap.get(unit.playerId);
        const el = document.createElement('div');
        el.className = 'unit' + (unit.playerId === myPlayerId && myTurn() ? ' mine' : '') +
          (selectedUnit === unit.id ? ' selected' : '');
        el.style.background = player ? player.color : '#888';
        el.innerHTML = '<span>' + (unit.type === 'vanguard' ? 'V' : 'S') + '</span>' +
          '<span class="hp">' + unit.hp + ' HP</span>';
        el.title = (player ? player.name : '?') + ' — ' +
          (unit.type === 'vanguard' ? 'Vanguard' : 'Scout') + ' (' + unit.hp + ' HP)';
        el.onclick = (ev) => { ev.stopPropagation(); onUnitClick(unit); };
        cell.appendChild(el);
      }
      if (legal && replayIndex < 0) {
        if (legal.reachable.some((c) => c.x === x && c.y === y)) {
          cell.classList.add('reachable');
        }
        if (unit && legal.attackable.includes(unit.id) && unit.playerId !== myPlayerId) {
          cell.classList.add('targetable');
        }
      }
      cell.onclick = () => onCellClick(x, y);
      board.appendChild(cell);
    }
  }
}

function renderPlayers() {
  const snap = replayIndex >= 0 && replayLog[replayIndex]
    ? replayLog[replayIndex].snapshot
    : null;
  const list = $('playerList');
  list.innerHTML = '';
  for (const p of game.players) {
    const li = document.createElement('li');
    if (game.currentPlayerId === p.id && game.status === 'active') li.className = 'current';
    const pts = snap
      ? (snap.points.find((q) => q.id === p.id) || {}).pts
      : p.beaconPoints;
    const aliveCount = (snap ? snap.units : game.units).filter((u) => u.playerId === p.id).length;
    const alive = snap
      ? (snap.points.find((q) => q.id === p.id) || {}).alive
      : p.alive;
    li.innerHTML = '<span><span class="dot" style="background:' + p.color + '"></span>' +
      p.name + (p.isBot ? ' (bot)' : '') + (p.id === myPlayerId ? ' — you' : '') +
      (alive === false ? ' — eliminated' : '') + '</span>' +
      '<span><span class="pts">' + pts + ' beacon</span> · ' + aliveCount + ' units</span>';
    list.appendChild(li);
  }
}

function renderLog() {
  const list = $('logList');
  list.innerHTML = '';
  const entries = game.log.slice(-30).reverse();
  for (const e of entries) {
    const li = document.createElement('li');
    li.textContent = e.text;
    list.appendChild(li);
  }
}

function updateTurnHint() {
  if (replayIndex >= 0) {
    $('turnHint').textContent = 'Viewing a replay snapshot. Press “Back to live” to return.';
    return;
  }
  if (game.status !== 'active') { $('turnHint').textContent = ''; return; }
  if (!myTurn()) {
    const current = game.players.find((p) => p.id === game.currentPlayerId);
    $('turnHint').textContent = current
      ? 'Waiting for ' + current.name + (current.isBot ? ' (bot is thinking…)' : '') + '.'
      : '';
    return;
  }
  $('turnHint').textContent = selectedUnit
    ? 'Unit selected. Click a highlighted tile to move, then click an adjacent enemy to attack — or End turn.'
    : 'Your turn. Click one of your units to see where it can move.';
}

async function onUnitClick(unit) {
  if (replayIndex >= 0 || !myTurn() || unit.playerId !== myPlayerId) return;
  if (selectedUnit === unit.id) {
    selectedUnit = null;
    legal = null;
    render();
    return;
  }
  try {
    legal = await api.get('/api/games/' + game.id + '/legal-moves?playerId=' + myPlayerId + '&unitId=' + unit.id);
    selectedUnit = unit.id;
    render();
  } catch (e) {
    toast('Could not load moves: ' + e.message);
  }
}

async function onCellClick(x, y) {
  if (replayIndex >= 0 || !myTurn() || !selectedUnit || !legal) return;
  const unit = game.units.find((u) => u.id === selectedUnit);
  if (!unit) return;
  const target = game.units.find((u) => u.x === x && u.y === y);
  // Clicked an attackable enemy: attack.
  if (target && target.playerId !== myPlayerId && legal.attackable.includes(target.id)) {
    try {
      game = await api.post('/api/games/' + game.id + '/attack', {
        playerId: myPlayerId, unitId: selectedUnit, targetId: target.id,
      });
      selectedUnit = null;
      legal = null;
      render();
      loadReplayLog();
    } catch (e) {
      toast('Attack failed: ' + e.message);
    }
    return;
  }
  // Clicked a reachable empty cell: move.
  if (!target && legal.reachable.some((c) => c.x === x && c.y === y)) {
    try {
      game = await api.post('/api/games/' + game.id + '/move', {
        playerId: myPlayerId, unitId: selectedUnit, to: { x, y },
      });
      // Refresh attack options from the new position.
      legal = await api.get('/api/games/' + game.id + '/legal-moves?playerId=' + myPlayerId + '&unitId=' + selectedUnit);
      render();
      if (!legal.attackable.length) toast('Moved. No enemy in range — End turn or wait.');
    } catch (e) {
      toast('Move failed: ' + e.message);
    }
  }
}

async function endTurn() {
  if (!myTurn()) return;
  try {
    game = await api.post('/api/games/' + game.id + '/end-turn', { playerId: myPlayerId });
    selectedUnit = null;
    legal = null;
    render();
  } catch (e) {
    toast('Could not end turn: ' + e.message);
  }
}

// ---------------- Replay ----------------

$('replayRange').addEventListener('input', (e) => {
  const idx = Number(e.target.value);
  replayIndex = idx;
  render();
  updateReplayLabel();
});
$('btnReplayLive').addEventListener('click', () => {
  replayIndex = -1;
  const range = $('replayRange');
  range.value = Math.max(0, replayLog.length - 1);
  render();
  updateReplayLabel();
});

// ---------------- Wire up ----------------

$('btnCreate').addEventListener('click', createGame);
$('btnJoin').addEventListener('click', joinGame);
$('btnQuick').addEventListener('click', quickGame);
$('btnEndTurn').addEventListener('click', endTurn);
$('btnLeave').addEventListener('click', leaveGame);

refreshGameList();
setInterval(() => { if (!game) refreshGameList(); }, 10000);
