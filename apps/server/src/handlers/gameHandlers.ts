import type { Socket, Server } from 'socket.io';
import type { ClientEvents, ServerEvents } from '@mafia/shared';
import { MIN_PLAYERS } from '@mafia/shared';
import { roomManager } from '../room/roomManager.js';
import { broadcastRoomUpdate } from '../utils/broadcast.js';
import { parsePayload } from '../utils/validate.js';
import {
    startCountdown,
    resolveVotes,
    tryResolveNightEarly,
    extendDiscussion,
    endDiscussion,
    resetRoomToLobby,
} from '../game/engine.js';

type IO = Server<ClientEvents, ServerEvents>;
type Sock = Socket<ClientEvents, ServerEvents>;

export function registerGameHandlers(socket: Sock, io: IO): void {
    // ── Game Start / Cancel ───────────────────────────────────────────────────

    socket.on('game:start', () => {
        const found = roomManager.getPlayerBySocket(socket.id);
        if (!found) return;
        const { room, player } = found;

        if (room.hostId !== player.playerId) {
            socket.emit('room:error', { code: 'not_host', message: 'Only the host can start the game.' });
            return;
        }
        if (room.phase !== 'lobby') {
            socket.emit('room:error', { code: 'in_progress', message: 'Game already in progress.' });
            return;
        }

        const connected = Array.from(room.players.values()).filter(p => p.isConnected).length;
        if (connected < MIN_PLAYERS) {
            socket.emit('room:error', { code: 'invalid_action', message: `Need at least ${MIN_PLAYERS} players to start.` });
            return;
        }

        roomManager.touch(room);
        startCountdown(room, io);
    });

    socket.on('game:cancel_start', () => {
        const found = roomManager.getPlayerBySocket(socket.id);
        if (!found) return;
        const { room, player } = found;
        if (room.hostId !== player.playerId || room.phase !== 'countdown') return;

        if (room.countdownInterval) {
            clearInterval(room.countdownInterval);
            room.countdownInterval = null;
        }

        room.phase = 'lobby';
        room.timerExpiresAt = null;
        roomManager.touch(room);

        io.to(room.code).emit('game:cancelled');
        broadcastRoomUpdate(io, room);
    });

    socket.on('game:acknowledge_role', () => {
        const found = roomManager.getPlayerBySocket(socket.id);
        if (!found) return;
        const { room, player } = found;
        if (room.phase !== 'role_reveal') return;

        player.hasAcknowledgedRole = true;
        roomManager.touch(room);
    });

    // ── Night Actions ─────────────────────────────────────────────────────────

    socket.on('game:night_action', (payload) => {
        const data = parsePayload(socket, 'game:night_action', payload);
        if (!data) return;

        const found = roomManager.getPlayerBySocket(socket.id);
        if (!found) return;
        const { room, player: actor } = found;
        if (room.phase !== 'night' || !actor.isAlive) return;

        // targetId: null retracts the actor's current choice — mafia/doctor
        // targets are freely changeable up until the round resolves. The
        // detective's inspect is a one-shot reveal (see the 'detective' case
        // below) and has nothing meaningful to retract.
        if (data.targetId === null) {
            if (actor.role === 'mafia') {
                room.mafiaVotes.delete(actor.playerId);
                actor.nightActionDone = false;
            } else if (actor.role === 'doctor') {
                room.doctorTarget = null;
                actor.nightActionDone = false;
            }
            roomManager.touch(room);
            socket.emit('game:night_ack', { success: true });
            return;
        }

        const target = room.players.get(data.targetId);
        if (!target?.isAlive) {
            socket.emit('game:night_ack', { success: false });
            return;
        }

        roomManager.touch(room);

        switch (actor.role) {
            case 'mafia': {
                if (target.role === 'mafia') {
                    socket.emit('game:night_ack', { success: false });
                    return;
                }
                // Map.set overwrites any earlier target this actor picked —
                // mafia is free to change their mind until night resolves.
                room.mafiaVotes.set(actor.playerId, target.playerId);
                actor.nightActionDone = true;
                socket.emit('game:night_ack', { success: true });
                break;
            }

            case 'doctor': {
                if (target.playerId === room.lastDoctorTarget) {
                    socket.emit('game:night_ack', { success: false });
                    return;
                }
                // Same overwrite-freely semantics as mafia, above.
                room.doctorTarget = target.playerId;
                actor.nightActionDone = true;
                socket.emit('game:night_ack', { success: true });
                break;
            }

            case 'detective': {
                // Deliberately final on the first successful call: the result
                // is revealed immediately, so allowing a second investigate
                // per night (by "changing" targets) would break the
                // one-inspection-per-night rule. This is the one role where
                // "select" and "commit" are the same action by design.
                if (room.detectiveUsed.has(actor.playerId)) return;
                room.detectiveUsed.add(actor.playerId);
                actor.nightActionDone = true;

                socket.emit('game:detective_result', {
                    round: room.round,
                    targetId: target.playerId,
                    targetName: target.name,
                    isMafia: target.role === 'mafia',
                });
                socket.emit('game:night_ack', { success: true });
                break;
            }

            default:
                socket.emit('game:night_ack', { success: false });
                return;
        }

        tryResolveNightEarly(room, io);
    });

    // ── Voting ────────────────────────────────────────────────────────────────

    socket.on('game:vote', (payload) => {
        const data = parsePayload(socket, 'game:vote', payload);
        if (!data) return;

        const found = roomManager.getPlayerBySocket(socket.id);
        if (!found) return;
        const { room, player: voter } = found;
        if (room.phase !== 'voting' || !voter.isAlive) return;

        const alive = Array.from(room.players.values()).filter(p => p.isAlive);

        // targetId: null retracts the current vote (covers both "deselect"
        // and the explicit Abstain action — either way resolveVotes' own
        // end-of-round fill-in treats a missing vote as an abstain).
        if (data.targetId === null) {
            room.votes.delete(voter.playerId);
            voter.hasVoted = false;
            voter.voteTarget = null;
            roomManager.touch(room);

            io.to(room.code).emit('game:vote_count', {
                votesIn: room.votes.size,
                totalVoters: alive.length,
            });
            return;
        }

        const target = room.players.get(data.targetId);
        if (!target?.isAlive || target.playerId === voter.playerId) return;

        // Map.set overwrites any earlier vote this voter cast — votes are
        // freely changeable up until the round resolves, exactly like
        // mafia/doctor night actions.
        room.votes.set(voter.playerId, target.playerId);
        voter.hasVoted = true;
        voter.voteTarget = target.playerId;
        roomManager.touch(room);

        io.to(room.code).emit('game:vote_count', {
            votesIn: room.votes.size,
            totalVoters: alive.length,
        });

        if (room.votes.size >= alive.length) {
            resolveVotes(room, io);
        }
    });

    // ── Timer Extension (host only, discussion phase) ─────────────────────────

    socket.on('game:extend_timer', () => {
        const found = roomManager.getPlayerBySocket(socket.id);
        if (!found) return;
        const { room, player } = found;
        if (room.hostId !== player.playerId) return;

        roomManager.touch(room);
        extendDiscussion(room, io);
    });

    socket.on('game:end_discussion', () => {
        const found = roomManager.getPlayerBySocket(socket.id);
        if (!found) return;
        const { room, player } = found;
        if (room.hostId !== player.playerId) return;

        roomManager.touch(room);
        endDiscussion(room, io);
    });

    // ── Post-Game ─────────────────────────────────────────────────────────────

    socket.on('game:play_again', () => {
        const found = roomManager.getPlayerBySocket(socket.id);
        if (!found) return;
        const { room, player } = found;
        if (room.hostId !== player.playerId || room.phase !== 'game_over') return;

        resetRoomToLobby(room, io);
        roomManager.touch(room);
        broadcastRoomUpdate(io, room);
    });
}
