import type { Phase, Role, RoomSettings } from '@mafia/shared';

export interface ServerPlayer {
    playerId: string;      // stable identity — survives reconnects, never reused
    sessionToken: string;  // opaque token bound to this playerId for rejoin
    socketId: string;      // current live socket id; stale/meaningless while disconnected
    name: string;
    avatarId: number;
    isAlive: boolean;
    isHost: boolean;
    isConnected: boolean;
    role: Role | null;
    hasAcknowledgedRole: boolean;
    nightActionDone: boolean;
    hasVoted: boolean;
    voteTarget: string | null; // playerId
}

export interface ServerRoom {
    code: string;
    hostId: string; // playerId of current host
    players: Map<string, ServerPlayer>; // keyed by playerId
    phase: Phase;
    round: number;
    settings: RoomSettings;
    createdAt: number;
    lastActivity: number;
    /** Timestamp since every player in the room has been disconnected, or null if someone is connected. */
    emptySince: number | null;

    // Night phase state (all keyed/valued by playerId)
    mafiaVotes: Map<string, string>;
    doctorTarget: string | null;
    lastDoctorTarget: string | null; // previous night's doctor target (consecutive rule)
    detectiveUsed: Set<string>; // detective playerIds who have used their power this game

    // Day phase state
    votes: Map<string, string>; // voter playerId → target playerId
    discussionExtensions: number;
    voteExtended: boolean;

    // Timer state
    timerExpiresAt: number | null;
    activeTimer: ReturnType<typeof setTimeout> | null;
    countdownInterval: ReturnType<typeof setInterval> | null;

    // Reconnection tracking: playerId → pending-removal timer handle
    disconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
}
