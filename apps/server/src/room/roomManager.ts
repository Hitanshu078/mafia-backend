import { randomUUID } from 'node:crypto';
import type { Player } from '@mafia/shared';
import {
    DEFAULT_SETTINGS,
    ROOM_IDLE_EXPIRATION_SECONDS,
    EMPTY_ROOM_DESTROY_SECONDS,
    RECONNECT_GRACE_SECONDS_INGAME,
    AVATAR_COUNT,
    MAX_PLAYERS,
} from '@mafia/shared';
import type { ServerRoom, ServerPlayer } from '../types/room.js';
import { generateRoomCode } from '../utils/codeGen.js';

const CLEANUP_SWEEP_INTERVAL_MS = 60_000;

interface Session {
    playerId: string;
    roomCode: string;
    socketId: string | null;
}

export type RoomStatus = 'lobby' | 'in_game' | 'finished' | 'not_found' | 'full';

class RoomManager {
    private rooms = new Map<string, ServerRoom>();
    private socketToRoom = new Map<string, string>(); // socketId → roomCode
    private sessions = new Map<string, Session>(); // sessionToken → session

    constructor() {
        setInterval(() => this.runCleanupSweep(), CLEANUP_SWEEP_INTERVAL_MS).unref();
    }

    // ── Room creation / joining ──────────────────────────────────────────────

    createRoom(
        socketId: string,
        playerName: string,
        avatarId?: number,
    ): { room: ServerRoom; player: ServerPlayer; sessionToken: string } {
        const codes = new Set(this.rooms.keys());
        const code = generateRoomCode(codes);
        const playerId = randomUUID();
        const sessionToken = randomUUID();

        const host: ServerPlayer = {
            playerId,
            sessionToken,
            socketId,
            name: playerName,
            avatarId: this.resolveAvatarId(null, avatarId),
            isAlive: true,
            isHost: true,
            isConnected: true,
            role: null,
            hasAcknowledgedRole: false,
            nightActionDone: false,
            hasVoted: false,
            voteTarget: null,
        };

        const room: ServerRoom = {
            code,
            hostId: playerId,
            players: new Map([[playerId, host]]),
            phase: 'lobby',
            round: 0,
            settings: { ...DEFAULT_SETTINGS },
            createdAt: Date.now(),
            lastActivity: Date.now(),
            emptySince: null,

            mafiaVotes: new Map(),
            doctorTarget: null,
            lastDoctorTarget: null,
            detectiveUsed: new Set(),

            votes: new Map(),
            discussionExtensions: 0,
            voteExtended: false,

            timerExpiresAt: null,
            activeTimer: null,
            countdownInterval: null,

            disconnectTimers: new Map(),
        };

        this.rooms.set(code, room);
        this.socketToRoom.set(socketId, code);
        this.sessions.set(sessionToken, { playerId, roomCode: code, socketId });

        return { room, player: host, sessionToken };
    }

    /** Brand-new join only — lobby phase only. Reconnection goes through rejoinBySession(). */
    joinRoom(
        code: string,
        socketId: string,
        playerName: string,
        avatarId?: number,
    ): { room: ServerRoom; player: ServerPlayer; sessionToken: string } | null {
        const room = this.rooms.get(code);
        if (!room) return null;
        if (room.phase !== 'lobby') return null;
        if (room.players.size >= MAX_PLAYERS) return null;

        const playerId = randomUUID();
        const sessionToken = randomUUID();

        const player: ServerPlayer = {
            playerId,
            sessionToken,
            socketId,
            name: playerName,
            avatarId: this.resolveAvatarId(room, avatarId),
            isAlive: true,
            isHost: false,
            isConnected: true,
            role: null,
            hasAcknowledgedRole: false,
            nightActionDone: false,
            hasVoted: false,
            voteTarget: null,
        };

        room.players.set(playerId, player);
        this.socketToRoom.set(socketId, code);
        this.sessions.set(sessionToken, { playerId, roomCode: code, socketId });
        room.lastActivity = Date.now();
        this.refreshEmptySince(room);

        return { room, player, sessionToken };
    }

    /** Reconnection via sessionToken — the only rejoin path. */
    rejoinBySession(
        sessionToken: string,
        socketId: string,
    ): { room: ServerRoom; player: ServerPlayer } | { error: 'not_found' } {
        const session = this.sessions.get(sessionToken);
        if (!session) return { error: 'not_found' };

        const room = this.rooms.get(session.roomCode);
        if (!room) {
            this.sessions.delete(sessionToken);
            return { error: 'not_found' };
        }

        const player = room.players.get(session.playerId);
        if (!player) {
            this.sessions.delete(sessionToken);
            return { error: 'not_found' };
        }

        const pendingRemoval = room.disconnectTimers.get(player.playerId);
        if (pendingRemoval) {
            clearTimeout(pendingRemoval);
            room.disconnectTimers.delete(player.playerId);
        }

        player.socketId = socketId;
        player.isConnected = true;
        session.socketId = socketId;
        this.socketToRoom.set(socketId, room.code);
        room.lastActivity = Date.now();
        this.refreshEmptySince(room);

        return { room, player };
    }

    getRoomStatus(code: string): RoomStatus {
        const room = this.rooms.get(code);
        if (!room) return 'not_found';
        if (room.phase === 'game_over') return 'finished';
        if (room.phase !== 'lobby') return 'in_game';
        if (room.players.size >= MAX_PLAYERS) return 'full';
        return 'lobby';
    }

    // ── Lookups ──────────────────────────────────────────────────────────────

    getRoomBySocket(socketId: string): ServerRoom | null {
        const code = this.socketToRoom.get(socketId);
        return code ? (this.rooms.get(code) ?? null) : null;
    }

    getPlayerBySocket(socketId: string): { room: ServerRoom; player: ServerPlayer } | null {
        const room = this.getRoomBySocket(socketId);
        if (!room) return null;
        const player = Array.from(room.players.values()).find(p => p.socketId === socketId);
        return player ? { room, player } : null;
    }

    getRoom(code: string): ServerRoom | null {
        return this.rooms.get(code) ?? null;
    }

    touch(room: ServerRoom): void {
        room.lastActivity = Date.now();
    }

    // ── Disconnect / removal ─────────────────────────────────────────────────

    /** Mark a player as disconnected and schedule their removal after the reconnect grace window. */
    markDisconnected(
        socketId: string,
        onRemove: (result: { room: ServerRoom; player: ServerPlayer; wasHost: boolean } | null) => void,
    ): void {
        const found = this.getPlayerBySocket(socketId);
        if (!found) return;
        const { room, player } = found;

        player.isConnected = false;
        this.refreshEmptySince(room);

        const timer = setTimeout(() => {
            room.disconnectTimers.delete(player.playerId);
            const result = this.removePlayer(room.code, player.playerId);
            onRemove(result);
        }, RECONNECT_GRACE_SECONDS_INGAME * 1000);

        room.disconnectTimers.set(player.playerId, timer);
        room.lastActivity = Date.now();
    }

    /** Permanently remove a player by their stable playerId. Returns the affected room and whether they were host. */
    removePlayer(roomCode: string, playerId: string): { room: ServerRoom; player: ServerPlayer; wasHost: boolean } | null {
        const room = this.rooms.get(roomCode);
        if (!room) return null;

        const player = room.players.get(playerId);
        if (!player) return null;

        const wasHost = player.isHost;
        room.players.delete(playerId);
        this.socketToRoom.delete(player.socketId);
        this.sessions.delete(player.sessionToken);
        // Drop any pending vote/night-action cast by this player so a departed
        // player's stale choice can't be tallied at resolution time.
        room.votes.delete(playerId);
        room.mafiaVotes.delete(playerId);

        const pendingRemoval = room.disconnectTimers.get(playerId);
        if (pendingRemoval) {
            clearTimeout(pendingRemoval);
            room.disconnectTimers.delete(playerId);
        }

        if (room.players.size === 0) {
            this.destroyRoom(room.code);
            return { room, player, wasHost };
        }

        if (wasHost) {
            const next = Array.from(room.players.values()).find(p => p.isConnected)
                ?? room.players.values().next().value!;
            next.isHost = true;
            room.hostId = next.playerId;
        }

        room.lastActivity = Date.now();
        this.refreshEmptySince(room);
        return { room, player, wasHost };
    }

    destroyRoom(code: string): void {
        const room = this.rooms.get(code);
        if (!room) return;

        if (room.activeTimer) clearTimeout(room.activeTimer);
        if (room.countdownInterval) clearInterval(room.countdownInterval);
        for (const t of room.disconnectTimers.values()) clearTimeout(t);

        for (const player of room.players.values()) {
            this.sessions.delete(player.sessionToken);
            this.socketToRoom.delete(player.socketId);
        }

        this.rooms.delete(code);
    }

    private runCleanupSweep(): void {
        const now = Date.now();
        for (const room of Array.from(this.rooms.values())) {
            if (now - room.lastActivity > ROOM_IDLE_EXPIRATION_SECONDS * 1000) {
                this.destroyRoom(room.code);
                continue;
            }
            if (room.emptySince !== null && now - room.emptySince > EMPTY_ROOM_DESTROY_SECONDS * 1000) {
                this.destroyRoom(room.code);
            }
        }
    }

    private refreshEmptySince(room: ServerRoom): void {
        const anyConnected = Array.from(room.players.values()).some(p => p.isConnected);
        if (anyConnected) {
            room.emptySince = null;
        } else if (room.emptySince === null) {
            room.emptySince = Date.now();
        }
    }

    // ── View projection ──────────────────────────────────────────────────────

    /**
     * Public player list for a given viewer. Roles are only included for the
     * viewer's own entry, unless the viewer is a spectator (eliminated mid-game)
     * or the game is over, in which case every role is visible.
     */
    getPublicPlayers(room: ServerRoom, viewerPlayerId?: string): Player[] {
        const viewer = viewerPlayerId ? room.players.get(viewerPlayerId) : undefined;
        const fullVisibility = room.phase === 'game_over' || (!!viewer && !viewer.isAlive && room.phase !== 'lobby');

        return Array.from(room.players.values()).map(p => ({
            id: p.playerId,
            name: p.name,
            avatarId: p.avatarId,
            isAlive: p.isAlive,
            isHost: p.isHost,
            isConnected: p.isConnected,
            role: (p.playerId === viewerPlayerId || fullVisibility) ? (p.role ?? undefined) : undefined,
        }));
    }

    // ── Avatars ──────────────────────────────────────────────────────────────

    /** Pick an avatar not yet claimed in the room; falls back to random. */
    getAvailableAvatarId(room: ServerRoom): number {
        const used = new Set(Array.from(room.players.values()).map(p => p.avatarId));
        const free = Array.from({ length: AVATAR_COUNT }, (_, i) => i + 1).filter(id => !used.has(id));
        return free.length > 0
            ? free[Math.floor(Math.random() * free.length)]
            : (Math.floor(Math.random() * AVATAR_COUNT) + 1);
    }

    private resolveAvatarId(room: ServerRoom | null, requested?: number): number {
        const isValid = typeof requested === 'number' && Number.isInteger(requested) && requested >= 1 && requested <= AVATAR_COUNT;
        if (isValid && room) {
            const used = new Set(Array.from(room.players.values()).map(p => p.avatarId));
            if (!used.has(requested!)) return requested!;
        } else if (isValid && !room) {
            return requested!;
        }
        return room ? this.getAvailableAvatarId(room) : Math.floor(Math.random() * AVATAR_COUNT) + 1;
    }
}

export const roomManager = new RoomManager();
