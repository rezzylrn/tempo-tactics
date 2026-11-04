# Tempo Tactics

A small multiplayer turn-based strategy game for 2–4 players, built for the Taskmarket multiplayer strategy bounty. Humans play in the browser at the public URL — no install, no login. Agents play through a simple documented HTTP/JSON API. One sample bot is included.

**Rules (one paragraph):** On a 7x7 board, each player commands 3 units — 1 Vanguard (4 HP, moves 2, hits for 2) and 2 Scouts (2 HP, moves 3, hits for 1) — starting from their corner. On your turn you activate a single unit: move it up to its range (8-directional, cannot pass through units), then optionally attack one adjacent enemy. You win by destroying every rival unit, or by holding the gold center tile at the end of a full round to earn a beacon point — first to 3 beacon points wins. Matches are capped at 60 turns and then decided on beacon points, units alive, then total HP, so a game always finishes in under 10 minutes.

## Play in the browser

Open the public game URL, then:

- **Quick game vs bot** — one click, you play Player 1 against the sample bot.
- **New game** — pick 2–4 players, share the 4-letter game code with friends; they join from the same page. Empty seats can be filled with bots, or the host can add bots and start.
- Click one of your units to see where it can move (green) and which enemies it can hit (red). Click a tile to move, click an adjacent enemy to attack, or press **End turn**. Bot seats move automatically. The match log and a replay slider sit beside the board.

## Run locally

Requires Node.js 18+ and nothing else (zero dependencies).

```bash
git clone https://github.com/rezzylrn/tempo-tactics.git
cd tempo-tactics
node server.js
# open http://localhost:3000
```

State lives in memory with a best-effort JSON snapshot in `data/games.json` (restored on restart). The server listens on `PORT` (default 3000).

## Deploy

The repo includes `render.yaml` for a one-click Render deploy (free web service, `node server.js`). Any Node host works the same way.

## Agent API

Base URL is the game URL. All responses are JSON. Errors return HTTP 400/404 with `{ "error": "message" }`. No auth, no login — pass the `playerId` you received when joining.

### Create a game

```bash
curl -s -X POST $BASE/api/games -H 'Content-Type: application/json' \
  -d '{"numPlayers": 2}'
# -> { "id": "…", "code": "K7Q2", "status": "lobby", "numPlayers": 2, "players": [], … }
```

### List games

```bash
curl -s $BASE/api/games
# -> { "games": [{ "id": "…", "code": "K7Q2", "status": "lobby", … }] }
```

### Read game state

```bash
curl -s $BASE/api/games/$GAME_ID
```

State includes `status` (`lobby`, `active`, `finished`), `players` (id, name, isBot, color, alive, beaconPoints), `units` (id, playerId, type, x, y, hp, maxHp), `currentPlayerId`, `turnCount`, `roundNumber`, `winnerId`, `draw`, `winReason`, `beaconTarget` (3), `maxTurns` (60), `boardSize` (7), and the last 30 `log` entries.

### Join a game

```bash
curl -s -X POST $BASE/api/games/$GAME_ID/join -H 'Content-Type: application/json' \
  -d '{"name": "MyBot"}'
# -> { "player": { "id": "…", "name": "MyBot", … }, "state": { … } }
```

Add `"bot": true` to join as a bot seat. Seats are filled in join order.

### Start a game

```bash
curl -s -X POST $BASE/api/games/$GAME_ID/start -H 'Content-Type: application/json' \
  -d '{"fillBots": true}'
# fills empty seats with bots, spawns units, Player 1 moves first
```

### Legal moves for a unit

```bash
curl -s "$BASE/api/games/$GAME_ID/legal-moves?playerId=$ME&unitId=$UNIT"
# -> { "reachable": [{ "x": 1, "y": 2 }, …], "attackable": ["<unitId>", …] }
```

### Move a unit

```bash
curl -s -X POST $BASE/api/games/$GAME_ID/move -H 'Content-Type: application/json' \
  -d '{"playerId": "'$ME'", "unitId": "'$UNIT'", "to": {"x": 1, "y": 2}}'
# -> updated game state. Moving does not end your turn.
```

### Attack

```bash
curl -s -X POST $BASE/api/games/$GAME_ID/attack -H 'Content-Type: application/json' \
  -d '{"playerId": "'$ME'", "unitId": "'$UNIT'", "targetId": "'$TARGET'"}'
# -> updated game state. Attacking ends your turn.
```

### End turn (pass, or after moving without attacking)

```bash
curl -s -X POST $BASE/api/games/$GAME_ID/end-turn -H 'Content-Type: application/json' \
  -d '{"playerId": "'$ME'"}'
```

### Play a bot turn (server-side sample bot)

```bash
curl -s -X POST $BASE/api/games/$GAME_ID/bot -H 'Content-Type: application/json' -d '{}'
# -> { "action": "move-attack" | "move" | "attack" | "pass", "state": { … } }
```

Plays the current player's turn using the built-in heuristic (prefers kills, then the beacon, then hunting). Only works for bot seats — humans play through the UI or the move/attack endpoints.

### Match log and replay

```bash
curl -s $BASE/api/games/$GAME_ID/log
# -> { "id": "…", "status": "…", "winnerId": "…", "log": [
#      { "seq": 1, "turn": 0, "round": 1, "type": "move",
#        "text": "…", "snapshot": { "units": […], "points": […], "currentPlayerId": "…" } } ] }
```

Every log entry carries a board snapshot, so a full replay can be rebuilt from the log alone.

### Turn rules for agents

- Only the current player may act; anything else returns 400.
- One unit acts per turn: after a unit moves or attacks, no other unit of yours may act until your next turn.
- A move must land on a cell from `legal-moves` (range, 8-directional, no passing through units).
- An attack must target an adjacent enemy unit (Chebyshev distance 1) and ends your turn.
- Beacon points are awarded at the end of a full round (after the last player's turn): if exactly one player has a unit on the center tile (3,3), they get 1 point.

## Sample bot

`bot.js` plays a complete bot-vs-bot match through the API:

```bash
node bot.js http://localhost:3000
```

`bots/sample-bot.js` is a minimal, commented bot that plays one turn for the current player using only the public endpoints — copy it and change the scoring to build your own. Run it with `node bots/sample-bot.js <gameId> [baseUrl]`.

## Design notes

- The fun bar is positioning: the beacon tempts everyone to the center, but a unit sitting on it is exposed, and hunting a rival's Vanguard while they chase the beacon is often the better play. No single line dominates — rushing loses units, turtling concedes points.
- Board, units and win conditions are intentionally small so a match fits in 10 minutes and the rules fit in one paragraph.
- Known limitations: game state is in-memory on one server instance (a restart clears open games; the on-disk snapshot is best-effort). The free Render tier sleeps after inactivity, so the first request after a pause can take ~30 seconds to wake the service.
