import type { Server } from 'socket.io';
import type { ClientEvents, ServerEvents, Role, DawnResult, VoteResult, GameOverPayload, Winner } from '@mafia/shared';
import {
    ROLE_DISTRIBUTION,
    PREGAME_COUNTDOWN_SECONDS,
    ROLE_REVEAL_GRACE_SECONDS,
    DAWN_HOLD_SECONDS,
    VOTE_RESULTS_HOLD_SECONDS,
    HOST_EXTENSION_INCREMENT_SECONDS,
    MAX_DISCUSSION_TOTAL_SECONDS,
    VOTE_AUTO_EXTENSION_SECONDS,
} from '@mafia/shared';
import type { ServerRoom } from '../types/room.js';
import { roomManager } from '../room/roomManager.js';
import { broadcastRoomUpdate } from '../utils/broadcast.js';

type IO = Server<ClientEvents, ServerEvents>;

// ─── Helpers ────────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function clearActive(room: ServerRoom): void {
    if (room.activeTimer) {
        clearTimeout(room.activeTimer);
        room.activeTimer = null;
    }
}

function emitPhase(io: IO, room: ServerRoom): void {
    io.to(room.code).emit('game:phase', {
        phase: room.phase,
        round: room.round,
        timerExpiresAt: room.timerExpiresAt,
    });
}

// ─── Role Assignment ─────────────────────────────────────────────────────────

export function assignRoles(room: ServerRoom): void {
    const dist = ROLE_DISTRIBUTION[room.players.size];
    if (!dist) throw new Error(`No role distribution for ${room.players.size} players`);

    const pool: Role[] = [];
    for (const [role, count] of Object.entries(dist) as [Role, number][]) {
        for (let i = 0; i < count; i++) pool.push(role);
    }

    const roles = shuffle(pool);
    let i = 0;
    for (const player of room.players.values()) {
        player.role = roles[i++];
        player.isAlive = true;
        player.hasAcknowledgedRole = false;
        player.nightActionDone = false;
        player.hasVoted = false;
        player.voteTarget = null;
    }
}

// ─── Win Condition ────────────────────────────────────────────────────────────

export function checkWinCondition(room: ServerRoom): Winner | null {
    const alive = Array.from(room.players.values()).filter(p => p.isAlive);
    const mafia = alive.filter(p => p.role === 'mafia');
    const city = alive.filter(p => p.role !== 'mafia');

    if (mafia.length === 0) return 'city';
    if (mafia.length >= city.length) return 'mafia';
    return null;
}

// ─── Game Flow ────────────────────────────────────────────────────────────────

export function startCountdown(room: ServerRoom, io: IO): void {
    room.phase = 'countdown';
    room.round = 0;
    room.timerExpiresAt = Date.now() + PREGAME_COUNTDOWN_SECONDS * 1000;
    let secondsLeft = PREGAME_COUNTDOWN_SECONDS;

    emitPhase(io, room);
    io.to(room.code).emit('game:countdown', { seconds: secondsLeft, expiresAt: Date.now() + secondsLeft * 1000 });

    room.countdownInterval = setInterval(() => {
        secondsLeft--;
        io.to(room.code).emit('game:countdown', { seconds: secondsLeft, expiresAt: Date.now() + secondsLeft * 1000 });

        if (secondsLeft <= 0) {
            clearInterval(room.countdownInterval!);
            room.countdownInterval = null;
            beginRoleReveal(room, io);
        }
    }, 1000);
}

function beginRoleReveal(room: ServerRoom, io: IO): void {
    if (room.phase !== 'countdown') return;

    assignRoles(room);
    room.phase = 'role_reveal';
    room.round = 1;
    room.timerExpiresAt = Date.now() + ROLE_REVEAL_GRACE_SECONDS * 1000;

    for (const player of room.players.values()) {
        const allies = player.role === 'mafia'
            ? Array.from(room.players.values())
                .filter(p => p.role === 'mafia' && p.playerId !== player.playerId)
                .map(p => ({ id: p.playerId, name: p.name }))
            : undefined;

        if (player.isConnected) {
            io.to(player.socketId).emit('game:role', { role: player.role!, allies });
        }
    }

    emitPhase(io, room);

    // Server advances after the grace period regardless of per-player acknowledgement.
    room.activeTimer = setTimeout(() => startNightPhase(room, io), ROLE_REVEAL_GRACE_SECONDS * 1000);
}

// ─── Night Phase ──────────────────────────────────────────────────────────────

export function startNightPhase(room: ServerRoom, io: IO): void {
    clearActive(room);
    room.phase = 'night';
    room.mafiaVotes = new Map();
    room.doctorTarget = null;
    room.detectiveUsed = new Set();

    for (const p of room.players.values()) {
        if (p.isAlive) p.nightActionDone = false;
    }

    const durationMs = room.settings.nightTimer * 1000;
    room.timerExpiresAt = Date.now() + durationMs;

    emitPhase(io, room);

    room.activeTimer = setTimeout(() => resolveNight(room, io), durationMs);
}

export function resolveNight(room: ServerRoom, io: IO): void {
    if (room.phase !== 'night') return;
    clearActive(room);

    // Tally mafia votes → pick target with most votes (first vote on tie)
    let mafiaTarget: string | null = null;
    if (room.mafiaVotes.size > 0) {
        const counts = new Map<string, number>();
        let firstTarget: string | null = null;

        for (const target of room.mafiaVotes.values()) {
            if (!firstTarget) firstTarget = target;
            counts.set(target, (counts.get(target) ?? 0) + 1);
        }

        let max = 0;
        const leaders: string[] = [];
        for (const [t, c] of counts) {
            if (c > max) { max = c; leaders.length = 0; leaders.push(t); }
            else if (c === max) leaders.push(t);
        }
        mafiaTarget = leaders.length === 1 ? leaders[0] : firstTarget!;
    }

    const saved = mafiaTarget !== null && room.doctorTarget === mafiaTarget;

    // Track for consecutive protection rule
    room.lastDoctorTarget = room.doctorTarget;

    let killed: DawnResult['killed'] = null;
    if (mafiaTarget && !saved) {
        const target = room.players.get(mafiaTarget);
        if (target?.isAlive) {
            target.isAlive = false;
            killed = {
                id: target.playerId,
                name: target.name,
                role: room.settings.roleRevealOnDeath ? (target.role ?? undefined) : undefined,
            };
        }
    }

    room.phase = 'dawn';
    room.timerExpiresAt = null;

    emitPhase(io, room);
    io.to(room.code).emit('game:dawn', { killed, saved });
    broadcastRoomUpdate(io, room);

    const winner = checkWinCondition(room);
    if (winner) {
        room.activeTimer = setTimeout(() => endGame(room, io, winner), DAWN_HOLD_SECONDS * 1000);
        return;
    }

    room.activeTimer = setTimeout(() => startDiscussionPhase(room, io), DAWN_HOLD_SECONDS * 1000);
}

/** Called eagerly after each night action to skip the timer when all roles acted. */
export function tryResolveNightEarly(room: ServerRoom, io: IO): void {
    if (room.phase !== 'night') return;

    const alive = Array.from(room.players.values()).filter(p => p.isAlive);
    const aliveMafia = alive.filter(p => p.role === 'mafia');
    const aliveDoctor = alive.filter(p => p.role === 'doctor');
    const aliveDetective = alive.filter(p => p.role === 'detective');

    const allMafiaVoted = aliveMafia.every(p => room.mafiaVotes.has(p.playerId));
    const doctorActed = aliveDoctor.length === 0 || room.doctorTarget !== null;
    const detectiveActed = aliveDetective.every(p => room.detectiveUsed.has(p.playerId));

    if (allMafiaVoted && doctorActed && detectiveActed) resolveNight(room, io);
}

// ─── Discussion Phase ─────────────────────────────────────────────────────────

export function startDiscussionPhase(room: ServerRoom, io: IO): void {
    clearActive(room);
    room.phase = 'discussion';
    room.discussionExtensions = 0;

    const durationMs = room.settings.discussionTimer * 1000;
    room.timerExpiresAt = Date.now() + durationMs;

    emitPhase(io, room);

    room.activeTimer = setTimeout(() => startVotingPhase(room, io), durationMs);
}

export function extendDiscussion(room: ServerRoom, io: IO): void {
    if (room.phase !== 'discussion') return;
    if (!room.settings.allowHostExtension) return;

    const maxExpiresAt = room.timerExpiresAt !== null
        ? room.timerExpiresAt - room.settings.discussionTimer * 1000 + MAX_DISCUSSION_TOTAL_SECONDS * 1000
        : Date.now() + MAX_DISCUSSION_TOTAL_SECONDS * 1000;
    const newExpiresAt = Math.min((room.timerExpiresAt ?? Date.now()) + HOST_EXTENSION_INCREMENT_SECONDS * 1000, maxExpiresAt);

    clearActive(room);
    room.timerExpiresAt = newExpiresAt;
    room.discussionExtensions++;

    emitPhase(io, room);

    room.activeTimer = setTimeout(() => startVotingPhase(room, io), Math.max(newExpiresAt - Date.now(), 0));
}

// ─── Voting Phase ─────────────────────────────────────────────────────────────

export function startVotingPhase(room: ServerRoom, io: IO): void {
    clearActive(room);
    room.phase = 'voting';
    room.votes = new Map();
    room.voteExtended = false;

    for (const p of room.players.values()) {
        p.hasVoted = false;
        p.voteTarget = null;
    }

    const durationMs = room.settings.voteTimer * 1000;
    room.timerExpiresAt = Date.now() + durationMs;

    emitPhase(io, room);

    room.activeTimer = setTimeout(() => onVotingTimeout(room, io), durationMs);
}

function onVotingTimeout(room: ServerRoom, io: IO): void {
    room.activeTimer = null;
    const aliveCount = Array.from(room.players.values()).filter(p => p.isAlive).length;

    if (room.votes.size < aliveCount && !room.voteExtended) {
        room.voteExtended = true;
        const newExpiresAt = Date.now() + VOTE_AUTO_EXTENSION_SECONDS * 1000;
        room.timerExpiresAt = newExpiresAt;

        io.to(room.code).emit('game:vote_extension', { newExpiresAt });
        room.activeTimer = setTimeout(() => resolveVotes(room, io), VOTE_AUTO_EXTENSION_SECONDS * 1000);
    } else {
        resolveVotes(room, io);
    }
}

export function resolveVotes(room: ServerRoom, io: IO): void {
    if (room.phase !== 'voting') return;
    clearActive(room);

    // Build tally: targetId → [voterIds]
    const tally: Record<string, string[]> = {};
    for (const [voterId, targetId] of room.votes) {
        (tally[targetId] ??= []).push(voterId);
    }

    let max = 0;
    const leaders: string[] = [];
    for (const [t, voters] of Object.entries(tally)) {
        if (voters.length > max) { max = voters.length; leaders.length = 0; leaders.push(t); }
        else if (voters.length === max) leaders.push(t);
    }

    const allAbstained = room.votes.size === 0;
    const tie = leaders.length !== 1 || max === 0;
    let eliminated: VoteResult['eliminated'] = null;

    if (!tie) {
        const ep = room.players.get(leaders[0]);
        if (ep) {
            ep.isAlive = false;
            eliminated = {
                id: ep.playerId,
                name: ep.name,
                role: room.settings.roleRevealOnDeath ? (ep.role ?? undefined) : undefined,
            };
        }
    }

    room.phase = 'vote_results';
    room.timerExpiresAt = null;

    emitPhase(io, room);
    io.to(room.code).emit('game:vote_results', { tally, eliminated, tie, allAbstained });
    broadcastRoomUpdate(io, room);

    const winner = checkWinCondition(room);
    if (winner) {
        room.activeTimer = setTimeout(() => endGame(room, io, winner), VOTE_RESULTS_HOLD_SECONDS * 1000);
        return;
    }

    room.activeTimer = setTimeout(() => {
        room.round++;
        startNightPhase(room, io);
    }, VOTE_RESULTS_HOLD_SECONDS * 1000);
}

// ─── Game Over ────────────────────────────────────────────────────────────────

export function endGame(room: ServerRoom, io: IO, winner: Winner): void {
    clearActive(room);
    room.phase = 'game_over';
    room.timerExpiresAt = null;

    const all = Array.from(room.players.values());
    const roles: Record<string, Role> = {};
    for (const p of all) {
        if (p.role) roles[p.playerId] = p.role;
    }

    // Map iteration order reflects join order, so this is already join-ordered.
    const winners = all.filter(p =>
        winner === 'city' ? p.role !== 'mafia' : p.role === 'mafia',
    );

    const summary: GameOverPayload = {
        winner,
        roles,
        leaderboard: winners.map(p => p.playerId),
        rounds: room.round,
    };

    emitPhase(io, room);
    io.to(room.code).emit('game:over', summary);
    broadcastRoomUpdate(io, room);

    // Auto-reset to lobby after 60 s in case host doesn't click "play again"
    room.activeTimer = setTimeout(() => {
        resetRoomToLobby(room);
        broadcastRoomUpdate(io, room);
    }, 60_000);
}

export function resetRoomToLobby(room: ServerRoom): void {
    clearActive(room);
    room.phase = 'lobby';
    room.round = 0;
    room.timerExpiresAt = null;

    for (const p of room.players.values()) {
        p.role = null;
        p.isAlive = true;
        p.hasAcknowledgedRole = false;
        p.nightActionDone = false;
        p.hasVoted = false;
        p.voteTarget = null;
    }

    room.mafiaVotes = new Map();
    room.doctorTarget = null;
    room.lastDoctorTarget = null;
    room.detectiveUsed = new Set();
    room.votes = new Map();
    room.discussionExtensions = 0;
    room.voteExtended = false;
}
