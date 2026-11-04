// Minimal sample bot for Tempo Tactics agents.
// This bot plays one turn for the current player using only the public API.
// Copy it, adapt the scoring, and run it against any game.
//
// Usage:
//   node sample-bot.js <gameId> [baseUrl]
//   baseUrl defaults to http://localhost:3000
//
// The server also exposes POST /api/games/:id/bot, which runs this same
// heuristic server-side. This file shows how to drive the game yourself:
// read state, ask for legal moves, pick an action, submit it.

const BASE = (process.argv[3] || 'http://localhost:3000').replace(/\/$/, '');
const GAME_ID = process.argv[2];

if (!GAME_ID) {
  console.error('usage: node sample-bot.js <gameId> [baseUrl]');
  process.exit(1);
}

async function api(path, method, body) {
  const res = await fetch(BASE + path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const CENTER = { x: 3, y: 3 };
const DMG = { vanguard: 2, scout: 1 };

async function playOneTurn() {
  const state = await api('/api/games/' + GAME_ID);
  if (state.status !== 'active') {
    console.log('game is', state.status);
    return;
  }
  const me = state.currentPlayerId;
  const myUnits = state.units.filter((u) => u.playerId === me);

  let best = null;
  const consider = (score, unitId, to, targetId) => {
    if (!best || score > best.score) best = { score, unitId, to, targetId };
  };

  for (const unit of myUnits) {
    const legal = await api(
      '/api/games/' + GAME_ID + '/legal-moves?playerId=' + me + '&unitId=' + unit.id
    );
    // Attack from here.
    for (const targetId of legal.attackable) {
      const target = state.units.find((u) => u.id === targetId);
      const kill = target.hp <= DMG[unit.type];
      consider(DMG[unit.type] * 10 + (kill ? 60 : 0), unit.id, null, targetId);
    }
    // Move somewhere useful.
    for (const cell of legal.reachable) {
      let score = -cheb(cell, CENTER) * 2;
      if (cell.x === CENTER.x && cell.y === CENTER.y) score += 45;
      const foe = state.units.find(
        (u) => u.playerId !== me && cheb(cell, u) <= 1
      );
      let targetId = null;
      if (foe) {
        const kill = foe.hp <= DMG[unit.type];
        score += DMG[unit.type] * 8 + (kill ? 45 : 0);
        targetId = foe.id;
      }
      consider(score, unit.id, cell, targetId);
    }
  }

  if (!best) {
    await api('/api/games/' + GAME_ID + '/end-turn', 'POST', { playerId: me });
    console.log('no action available, passed the turn');
    return;
  }
  if (best.to) {
    await api('/api/games/' + GAME_ID + '/move', 'POST', {
      playerId: me, unitId: best.unitId, to: best.to,
    });
    console.log('moved', best.unitId, 'to', JSON.stringify(best.to));
  }
  if (best.targetId) {
    await api('/api/games/' + GAME_ID + '/attack', 'POST', {
      playerId: me, unitId: best.unitId, targetId: best.targetId,
    });
    console.log('attacked', best.targetId);
  } else {
    await api('/api/games/' + GAME_ID + '/end-turn', 'POST', { playerId: me });
    console.log('ended turn');
  }
}

playOneTurn().catch((e) => {
  console.error('sample bot failed:', e.message);
  process.exit(1);
});
