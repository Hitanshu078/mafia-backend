import express from 'express';
import { createServer as createHttpServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import { MIN_PLAYERS, MAX_PLAYERS } from '@mafia/shared';
import type { ClientEvents, ServerEvents } from '@mafia/shared';
import { registerLobbyHandlers, leaveRoom } from './handlers/lobbyHandlers.js';
import { registerGameHandlers } from './handlers/gameHandlers.js';
import { roomManager } from './room/roomManager.js';
import { broadcastRoomUpdate, emitHostTransferred } from './utils/broadcast.js';
import { tryResolveNightEarly, resolveVotes } from './game/engine.js';
import { socketEventLimiter } from './utils/rateLimit.js';

export interface MafiaServer {
    httpServer: ReturnType<typeof createHttpServer>;
    io: Server<ClientEvents, ServerEvents>;
    port: number;
    close: () => Promise<void>;
}

/**
 * Builds and starts the Express + Socket.IO server. Extracted from index.ts
 * so tests can spin up an isolated instance on an ephemeral port (pass 0)
 * instead of always binding the real PORT/CORS_ORIGIN env config.
 */
export function createMafiaServer(port: number | string = process.env.PORT || 3001, corsOriginEnv = process.env.CORS_ORIGIN): Promise<MafiaServer> {
    const app = express();
    app.use(helmet());

    const corsOrigin = (corsOriginEnv || 'http://localhost:5173')
        .split(',')
        .map(origin => origin.trim());

    app.use(cors({ origin: corsOrigin }));

    const httpServer = createHttpServer(app);
    const io = new Server<ClientEvents, ServerEvents>(httpServer, {
        cors: {
            origin: corsOrigin,
            methods: ['GET', 'POST'],
        },
        transports: ['websocket'],
    });

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS });
    });

    io.on('connection', (socket) => {
        console.log(`connected: ${socket.id}`);
        registerLobbyHandlers(socket, io);
        registerGameHandlers(socket, io);

        // Blunt an event flood from a single client — legitimate play never
        // comes close to this rate; a buggy or malicious client spamming
        // events does.
        socket.use((_packet, next) => {
            if (socketEventLimiter.check(socket.id)) {
                next();
            } else {
                socket.emit('room:error', { code: 'rate_limit', message: 'Too many actions — slow down.' });
            }
        });

        socket.on('disconnect', (reason) => {
            console.log(`disconnected: ${socket.id} (${reason})`);
            socketEventLimiter.clear(socket.id);
            const room = roomManager.getRoomBySocket(socket.id);
            if (!room) return;

            if (room.phase === 'lobby') {
                leaveRoom(socket, io);
            } else {
                roomManager.markDisconnected(socket.id, (result) => {
                    if (!result) return;
                    console.log(`removed after reconnect timeout: room ${room.code}, was host: ${result.wasHost}`);

                    const stillExists = roomManager.getRoom(room.code);
                    if (!stillExists) return;

                    if (result.wasHost) emitHostTransferred(io, stillExists);
                    broadcastRoomUpdate(io, stillExists);

                    if (stillExists.phase === 'night') {
                        tryResolveNightEarly(stillExists, io);
                    } else if (stillExists.phase === 'voting') {
                        const alive = Array.from(stillExists.players.values()).filter(p => p.isAlive).length;
                        if (stillExists.votes.size >= alive) resolveVotes(stillExists, io);
                    }
                });

                broadcastRoomUpdate(io, room);
            }
        });
    });

    return new Promise((resolve) => {
        httpServer.listen(port, () => {
            const address = httpServer.address();
            const actualPort = typeof address === 'object' && address ? address.port : Number(port);
            resolve({
                httpServer,
                io,
                port: actualPort,
                close: () => new Promise<void>((res) => {
                    io.close();
                    httpServer.close(() => res());
                }),
            });
        });
    });
}
