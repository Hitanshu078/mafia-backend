import type { Socket, Server } from 'socket.io';
import type { ClientEvents, ServerEvents } from '@mafia/shared';
import {
    DISCUSSION_TIMER_MIN_SECONDS,
    DISCUSSION_TIMER_MAX_SECONDS,
    VOTE_TIMER_MIN_SECONDS,
    VOTE_TIMER_MAX_SECONDS,
    TIMER_STEP_SECONDS,
    MAX_PLAYERS,
} from '@mafia/shared';

function isValidTimer(value: number, min: number, max: number): boolean {
    return value >= min && value <= max && (value - min) % TIMER_STEP_SECONDS === 0;
}
import { roomManager } from '../room/roomManager.js';
import { broadcastRoomUpdate, emitHostTransferred } from '../utils/broadcast.js';
import { parsePayload } from '../utils/validate.js';
import { tryResolveNightEarly, resolveVotes } from '../game/engine.js';
import { roomCreateLimiter } from '../utils/rateLimit.js';

type IO = Server<ClientEvents, ServerEvents>;
type Sock = Socket<ClientEvents, ServerEvents>;

export function registerLobbyHandlers(socket: Sock, io: IO): void {
    socket.on('room:create', (payload) => {
        const data = parsePayload(socket, 'room:create', payload);
        if (!data) return;

        if (!roomCreateLimiter.check(socket.handshake.address)) {
            socket.emit('room:error', { code: 'rate_limit', message: 'Too many rooms created — try again in a minute.' });
            return;
        }

        const { room, player, sessionToken } = roomManager.createRoom(socket.id, data.playerName.trim(), data.avatarId);
        socket.join(room.code);

        socket.emit('room:created', {
            code: room.code,
            player: roomManager.getPublicPlayers(room, player.playerId).find(p => p.id === player.playerId)!,
            sessionToken,
        });
    });

    socket.on('room:join', (payload) => {
        const data = parsePayload(socket, 'room:join', payload);
        if (!data) return;

        const upper = data.code.toUpperCase();
        const room = roomManager.getRoom(upper);
        if (!room) {
            socket.emit('room:error', { code: 'not_found', message: 'Room not found.' });
            return;
        }
        if (room.phase !== 'lobby') {
            socket.emit('room:error', { code: 'in_progress', message: 'This game has already started.' });
            return;
        }
        if (room.players.size >= MAX_PLAYERS) {
            socket.emit('room:error', { code: 'full', message: 'Room is full.' });
            return;
        }

        const trimmed = data.playerName.trim();
        const nameTaken = Array.from(room.players.values()).some(p => p.name.toLowerCase() === trimmed.toLowerCase());
        if (nameTaken) {
            socket.emit('room:error', {
                code: 'duplicate_name',
                message: 'Name already taken in this room.',
                suggestedName: `${trimmed}${Math.floor(Math.random() * 100)}`,
            });
            return;
        }

        const result = roomManager.joinRoom(upper, socket.id, trimmed, data.avatarId);
        if (!result) {
            socket.emit('room:error', { code: 'generic', message: 'Cannot join this room right now.' });
            return;
        }

        const { room: joined, player, sessionToken } = result;
        socket.join(joined.code);

        const viewerPlayers = roomManager.getPublicPlayers(joined, player.playerId);
        socket.emit('room:joined', {
            code: joined.code,
            player: viewerPlayers.find(p => p.id === player.playerId)!,
            sessionToken,
            players: viewerPlayers,
            settings: joined.settings,
        });

        broadcastRoomUpdate(io, joined);
    });

    socket.on('room:check', (payload, callback) => {
        if (typeof callback !== 'function') return;
        const data = payload && typeof payload.code === 'string' ? payload : null;
        if (!data) {
            callback({ exists: false, status: 'not_found' });
            return;
        }
        const status = roomManager.getRoomStatus(data.code.toUpperCase());
        callback({ exists: status !== 'not_found', status });
    });

    socket.on('player:rejoin', (payload) => {
        const data = parsePayload(socket, 'player:rejoin', payload);
        if (!data) return;

        const result = roomManager.rejoinBySession(data.sessionToken, socket.id);
        if ('error' in result) {
            socket.emit('room:error', { code: 'not_found', message: 'Session expired or invalid.' });
            return;
        }

        const { room, player } = result;
        socket.join(room.code);

        const allies = player.role === 'mafia'
            ? Array.from(room.players.values())
                .filter(p => p.role === 'mafia' && p.playerId !== player.playerId)
                .map(p => ({ id: p.playerId, name: p.name }))
            : undefined;

        socket.emit('player:reconnected', {
            gameState: {
                phase: room.phase,
                round: room.round,
                timerExpiresAt: room.timerExpiresAt,
                players: roomManager.getPublicPlayers(room, player.playerId),
                settings: room.settings,
                myRole: player.role ?? undefined,
                myAllies: allies,
                doctorLastProtected: player.role === 'doctor' ? room.lastDoctorTarget : undefined,
            },
        });

        broadcastRoomUpdate(io, room);
    });

    socket.on('room:leave', () => {
        leaveRoom(socket, io);
    });

    socket.on('room:kick', (payload) => {
        const data = parsePayload(socket, 'room:kick', payload);
        if (!data) return;

        const room = roomManager.getRoomBySocket(socket.id);
        if (!room) return;
        const kicker = Array.from(room.players.values()).find(p => p.socketId === socket.id);
        if (!kicker || room.hostId !== kicker.playerId) {
            socket.emit('room:error', { code: 'not_host', message: 'Only the host can kick players.' });
            return;
        }
        if (room.phase !== 'lobby') {
            socket.emit('room:error', { code: 'in_progress', message: 'Cannot kick players during a game.' });
            return;
        }

        const target = room.players.get(data.targetId);
        if (!target) return;

        if (target.isConnected) {
            io.to(target.socketId).emit('room:kicked');
            io.sockets.sockets.get(target.socketId)?.leave(room.code);
        }

        const result = roomManager.removePlayer(room.code, data.targetId);
        roomManager.touch(room);

        const stillExists = roomManager.getRoom(room.code);
        if (stillExists) {
            if (result?.wasHost) emitHostTransferred(io, stillExists);
            broadcastRoomUpdate(io, stillExists);
        }
    });

    socket.on('room:settings', (payload) => {
        const data = parsePayload(socket, 'room:settings', payload);
        if (!data) return;

        const room = roomManager.getRoomBySocket(socket.id);
        if (!room) return;
        const requester = Array.from(room.players.values()).find(p => p.socketId === socket.id);
        if (!requester || room.hostId !== requester.playerId || room.phase !== 'lobby') return;

        if (data.discussionTimer !== undefined && !isValidTimer(data.discussionTimer, DISCUSSION_TIMER_MIN_SECONDS, DISCUSSION_TIMER_MAX_SECONDS)) return;
        if (data.voteTimer !== undefined && !isValidTimer(data.voteTimer, VOTE_TIMER_MIN_SECONDS, VOTE_TIMER_MAX_SECONDS)) return;

        Object.assign(room.settings, data);
        roomManager.touch(room);
        broadcastRoomUpdate(io, room);
    });
}

export function leaveRoom(socket: Sock, io: IO): void {
    const found = roomManager.getPlayerBySocket(socket.id);
    if (!found) return;
    const { room, player } = found;

    const result = roomManager.removePlayer(room.code, player.playerId);
    if (!result) return;

    socket.leave(room.code);

    const stillExists = roomManager.getRoom(room.code);
    if (!stillExists) return;

    if (result.wasHost) emitHostTransferred(io, stillExists);
    broadcastRoomUpdate(io, stillExists);

    // A departure can make an in-progress round resolvable early (e.g. the
    // last player whose action was pending just left) — re-check instead of
    // waiting out the full timer.
    if (stillExists.phase === 'night') {
        tryResolveNightEarly(stillExists, io);
    } else if (stillExists.phase === 'voting') {
        const alive = Array.from(stillExists.players.values()).filter(p => p.isAlive).length;
        if (stillExists.votes.size >= alive) resolveVotes(stillExists, io);
    }
}
