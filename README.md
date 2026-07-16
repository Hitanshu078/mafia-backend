# Mafia — Backend

Express 5 + Socket.IO game server for the Mafia party game. Room lifecycle,
role assignment, and the full night/day phase state machine live in
`apps/server`; the wire contract (types, events, Zod schemas, constants) is
shared from `packages/shared`.

The real frontend lives in a sibling repository and is the source of truth for
the event contract this server implements. `apps/client` in this repo is an
unrelated, unmodified Next.js starter template — ignore it.

## Quick start

```bash
pnpm install
cd apps/server
cp .env.example .env      # PORT + CORS_ORIGIN — defaults work for local dev
pnpm dev                  # tsx watch src/index.ts, listens on :3001
```

Health check: `GET /health` → `{ status, minPlayers, maxPlayers }`.

Point a frontend's `VITE_SOCKET_URL` at this server's URL (see the frontend
repo's `.env.example`).

## Manual multi-player testing

Two CLI tools exist for exercising the server without a browser:

```bash
pnpm --filter server exec tsx src/__tests__/manual-test.ts   # scripted 5-bot game, logs everything
```

```powershell
./launch-game.ps1   # opens 5 PowerShell windows running the interactive CLI client
```

The interactive client (`src/__tests__/player-client.ts`) supports create/join,
all game actions, and a `rejoin` option that reads back a session token saved
to a temp file — useful for manually testing the reconnect flow.

## Build & test

```bash
pnpm build   # tsc → apps/server/dist/
pnpm start   # node dist/index.js
pnpm test    # vitest — room lifecycle, full game flow, reconnect, disconnect/host-transfer
```

## Deployment

This is a stateful, long-running Socket.IO server — it needs a persistent
Node process (Railway, Render, Fly.io, a VPS, etc.), **not** a serverless
function; WebSockets don't survive on most serverless platforms.

Required environment variables in production:

| Var | Required | Notes |
|---|---|---|
| `PORT` | no | defaults to `3001`; most hosts inject this for you |
| `CORS_ORIGIN` | **yes** | comma-separated list of your deployed frontend origin(s), no trailing slash. The `http://localhost:5173` default only works in local dev. |

All game state is in-memory (no database) — a restart drops every active
room. That's an intentional scope decision (rooms are short-lived and
ephemeral by design), not an oversight. It does mean this server can't be
horizontally scaled behind a load balancer without adding a shared store
(e.g. a Socket.IO Redis adapter) for room state — out of scope unless you
actually need multi-instance capacity.

**Rate limiting**: a basic in-memory limiter blunts event floods from a
single socket, and a per-IP limiter caps `room:create` — generous enough for
a group replaying several games on shared WiFi, tight enough to stop a
scripted flood. See `src/utils/rateLimit.ts` if you need to tune the numbers.

**Crash recovery**: `index.ts` exits on an uncaught exception/rejection
rather than limping along with possibly-corrupted state, and handles
`SIGTERM`/`SIGINT` for a clean shutdown. That means *something* needs to
restart the process when it exits:
- Railway, Render, and Fly.io all restart a crashed process automatically —
  no extra config needed.
- Self-hosting on a bare VPS needs a process manager. With `pm2`:
  ```bash
  npm i -g pm2
  pm2 start dist/index.js --name mafia-server
  pm2 startup   # re-launch pm2 itself on server reboot
  pm2 save
  ```
  Or a systemd unit with `Restart=always`.

## Architecture

```
apps/server/src/
  index.ts       bootstrap — Express + Socket.IO + Helmet, CORS, health check, disconnect handling
  room/          roomManager — in-memory rooms, stable playerId/session model, cleanup sweep
  handlers/      lobbyHandlers (room:*), gameHandlers (game:*)
  game/          engine — role assignment, phase state machine, voting, win conditions
  types/         server-internal Room/Player shapes
  utils/         room code generation, Zod payload validation, broadcast helpers
packages/shared/src/  Player/Room/Phase/etc. types, the ClientEvents/ServerEvents contract, Zod schemas, constants
```

Players are identified by a stable server-generated `playerId`, not the raw
Socket.IO `socket.id` — the latter changes on every reconnect, so anything
keyed by it (votes, host status, kick targets) would silently break across a
refresh. A `sessionToken` issued on `room:create`/`room:join` is what the
client persists and replays via `player:rejoin` to resume as the same player
after a disconnect.
