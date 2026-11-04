// QA: bot-vs-bot matches + API validation for Tempo Tactics.
// Usage: node qa/test-match.js [baseUrl]   (default http://localhost:3000)
// Exit code 0 = all checks passed.

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
  if (ok) {
    passed++;
    console.log('PASS', name);
  } else {
    failed++;
    console.log('FAIL', name, extra ? '(' + extra + ')' : '');
  }
}

async function api(path, method, body) {
  const res = await fetch(BASE + path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function playBotMatch(numPlayers) {
  const created = await api('/api/games', 'POST', { numPlayers });
  const id = created.data.id;
  await api('/api/games/' + id + '/join', 'POST', { name: 'QA-A' });
  const started = await api('/api/games/' + id + '/start', 'POST', { fillBots: true });
  let state = started.data;
  let guard = 0;
  while (state.status === 'active' && guard < 200) {
    const r = await api('/api/games/' + id + '/bot', 'POST', {});
    if (r.status !== 200) return { error: 'bot call failed: ' + JSON.stringify(r.data), id };
    state = r.data.state;
    guard++;
  }
  return { state, id, turns: guard };
}

async function main() {
  // Health
  const health = await api('/healthz');
  check('health endpoint', health.status === 200 && health.data.ok === true);

  // --- Bot-vs-bot matches (2P, 3P, 4P) ---
  const results = {};
  for (const n of [2, 3, 4]) {
    const m = await playBotMatch(n);
    if (m.error) {
      check(n + 'P bot-vs-bot completes', false, m.error);
      continue;
    }
    const s = m.state;
    check(n + 'P bot-vs-bot completes', s.status === 'finished', 'status=' + s.status);
    check(n + 'P match ends within turn limit', s.turnCount <= 61, 'turns=' + s.turnCount);
    check(n + 'P match has a winner or a draw', !!s.winnerId || s.draw === true);
    const log = await api('/api/games/' + m.id + '/log');
    check(n + 'P log has snapshots', Array.isArray(log.data.log) && log.data.log.length > 0 &&
      !!log.data.log[0].snapshot && Array.isArray(log.data.log[0].snapshot.units));
    results[n + 'P'] = s.draw ? 'draw' : (s.winReason + ' / ' + (s.players.find((p) => p.id === s.winnerId) || {}).name);
    console.log('  -> ' + n + 'P result:', results[n + 'P'], '| turns:', s.turnCount);
  }

  // --- Manual API play: move + attack + end-turn, and invalid moves ---
  const created = await api('/api/games', 'POST', { numPlayers: 2 });
  const id = created.data.id;
  const p1 = await api('/api/games/' + id + '/join', 'POST', { name: 'QA-Human' });
  const me = p1.data.player.id;
  await api('/api/games/' + id + '/start', 'POST', { fillBots: true });
  let state = (await api('/api/games/' + id)).data;
  check('manual game starts, P1 to move', state.status === 'active' && state.currentPlayerId === me);
  const myScout = state.units.find((u) => u.playerId === me && u.type === 'scout');
  const legal = await api('/api/games/' + id + '/legal-moves?playerId=' + me + '&unitId=' + myScout.id);
  check('legal-moves returns reachable cells', legal.status === 200 && legal.data.reachable.length > 0);

  // Invalid: move to a far cell.
  const bad = await api('/api/games/' + id + '/move', 'POST', { playerId: me, unitId: myScout.id, to: { x: 6, y: 6 } });
  check('unreachable move rejected', bad.status === 400, 'status=' + bad.status);

  // Invalid: act as the other player.
  const other = state.players.find((p) => p.id !== me);
  const bad2 = await api('/api/games/' + id + '/move', 'POST', {
    playerId: other.id, unitId: myScout.id, to: legal.data.reachable[0],
  });
  check('wrong-player move rejected', bad2.status === 400, 'status=' + bad2.status);

  // Valid move, then end turn.
  const dest = legal.data.reachable[0];
  const moved = await api('/api/games/' + id + '/move', 'POST', { playerId: me, unitId: myScout.id, to: dest });
  check('valid move accepted', moved.status === 200, 'status=' + moved.status);
  const afterMove = moved.data;
  check('unit actually moved', afterMove.units.find((u) => u.id === myScout.id).x === dest.x);

  // Invalid: a second unit may not act this turn.
  const myVanguard = state.units.find((u) => u.playerId === me && u.type === 'vanguard');
  const legalV = await api('/api/games/' + id + '/legal-moves?playerId=' + me + '&unitId=' + myVanguard.id);
  const bad3 = await api('/api/games/' + id + '/move', 'POST', {
    playerId: me, unitId: myVanguard.id, to: legalV.data.reachable[0],
  });
  check('second unit same turn rejected', bad3.status === 400, 'status=' + bad3.status);

  const ended = await api('/api/games/' + id + '/end-turn', 'POST', { playerId: me });
  check('end turn advances to next player', ended.status === 200 && ended.data.currentPlayerId === other.id);

  // Invalid: attack out of range (fresh game, adjacent check).
  const created2 = await api('/api/games', 'POST', { numPlayers: 2 });
  const id2 = created2.data.id;
  const q1 = await api('/api/games/' + id2 + '/join', 'POST', { name: 'QA-Human2' });
  const me2 = q1.data.player.id;
  await api('/api/games/' + id2 + '/start', 'POST', { fillBots: true });
  const s2 = (await api('/api/games/' + id2)).data;
  const foe = s2.units.find((u) => u.playerId !== me2);
  const myUnit2 = s2.units.find((u) => u.playerId === me2 && u.type === 'vanguard');
  const badAtk = await api('/api/games/' + id2 + '/attack', 'POST', { playerId: me2, unitId: myUnit2.id, targetId: foe.id });
  check('out-of-range attack rejected', badAtk.status === 400, 'status=' + badAtk.status);

  // Unknown game 404.
  const missing = await api('/api/games/doesnotexist');
  check('unknown game returns 404', missing.status === 404);

  console.log('---');
  console.log('QA result: ' + passed + ' passed, ' + failed + ' failed');
  console.log('match outcomes:', JSON.stringify(results));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('QA crashed:', e.message);
  process.exit(1);
});
