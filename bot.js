// Sample bot for Tempo Tactics.
// Plays a full game through the public HTTP/JSON API — no special access.
// Usage: node bot.js [baseUrl]
//   baseUrl defaults to http://localhost:3000
// The bot creates a 2-player game, fills the second seat with the server bot,
// then plays both sides by calling POST /api/games/:id/bot until the game ends.
// This is also the script used for QA: a complete bot-vs-bot match.

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');

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

async function main() {
  const created = await api('/api/games', 'POST', { numPlayers: 2 });
  const gameId = created.id;
  console.log('game created:', gameId, 'code:', created.code);

  const p1 = await api('/api/games/' + gameId + '/join', 'POST', { name: 'SampleBot-A' });
  console.log('player 1:', p1.player.id, p1.player.name);

  const started = await api('/api/games/' + gameId + '/start', 'POST', { fillBots: true });
  console.log('started. players:', started.players.map((p) => p.name + (p.isBot ? ' (bot)' : '')).join(', '));

  let state = started;
  let turns = 0;
  while (state.status === 'active' && turns < 200) {
    const result = await api('/api/games/' + gameId + '/bot', 'POST', {});
    state = result.state;
    turns++;
    const current = state.players.find((p) => p.id === state.currentPlayerId);
    console.log('turn ' + state.turnCount + ': ' + (current ? current.name : '?') + ' to move' +
      ' | points: ' + state.players.map((p) => p.name + '=' + p.beaconPoints).join(', '));
  }

  console.log('---');
  console.log('status:', state.status, '| turns played:', state.turnCount);
  if (state.draw) {
    console.log('result: draw');
  } else {
    const winner = state.players.find((p) => p.id === state.winnerId);
    console.log('winner:', winner ? winner.name : 'unknown', '| reason:', state.winReason);
  }
  const log = await api('/api/games/' + gameId + '/log');
  console.log('--- match log (' + log.log.length + ' events) ---');
  for (const e of log.log) console.log('#' + e.seq, 't' + e.turn, e.type + ':', e.text);
  console.log('---');
  console.log('play it back in a browser: ' + BASE + '/ (game code ' + state.code + ')');
}

main().catch((e) => {
  console.error('bot failed:', e.message);
  process.exit(1);
});
