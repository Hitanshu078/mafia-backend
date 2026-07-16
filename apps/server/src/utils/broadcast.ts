import type { Server } from 'socket.io';
import type { ClientEvents, ServerEvents } from '@mafia/shared';
import type { ServerRoom } from '../types/room.js';
import { roomManager } from '../room/roomManager.js';

type IO = Server<ClientEvents, ServerEvents>;

/**
 * Emits room:updated individually to each connected player, filtering role
 * visibility per-recipient (see roomManager.getPublicPlayers) instead of a
 * single io.to(room).emit with one shared payload.
 */
export function broadcastRoomUpdate(io: IO, room: ServerRoom): void {
    for (const player of room.players.values()) {
        if (!player.isConnected) continue;
        io.to(player.socketId).emit('room:updated', {
            players: roomManager.getPublicPlayers(room, player.playerId),
            settings: room.settings,
        });
    }
}

export function emitHostTransferred(io: IO, room: ServerRoom): void {
    const host = room.players.get(room.hostId);
    if (!host) return;
    io.to(room.code).emit('room:host_transferred', { newHostId: host.playerId, newHostName: host.name });
}
