// ============================================
// MAFIA — WebSocket Event Contracts (Socket.IO typing)
// ============================================
// Function-signature form of the schemas in ./schemas.ts, used to type
// Socket.IO's Server<ClientEvents, ServerEvents> generics.
// ============================================

import type {
    Player,
    Role,
    Phase,
    RoomSettings,
    DawnResult,
    VoteResult,
    GameOverPayload,
    DetectiveEntry,
    GameState,
    ErrorCode,
} from './types.js';

// ---- CLIENT → SERVER ----

export interface ClientEvents {
    // Lobby
    'room:create': (data: { playerName: string; avatarId: number }) => void;
    'room:join': (data: { code: string; playerName: string; avatarId: number }) => void;
    'room:leave': () => void;
    'room:kick': (data: { targetId: string }) => void;
    'room:settings': (data: Partial<RoomSettings>) => void;
    'room:check': (
        data: { code: string },
        callback: (res: { exists: boolean; status: 'lobby' | 'in_game' | 'finished' | 'not_found' | 'full' }) => void,
    ) => void;

    // Game flow
    'game:start': () => void;
    'game:cancel_start': () => void;
    'game:acknowledge_role': () => void;

    // Night actions
    'game:night_action': (data: { targetId: string | null }) => void;

    // Day actions
    'game:vote': (data: { targetId: string | null }) => void;
    'game:extend_timer': () => void;
    'game:end_discussion': () => void;

    // Post-game
    'game:play_again': () => void;

    // Reconnection
    'player:rejoin': (data: { sessionToken: string }) => void;
}

// ---- SERVER → CLIENT ----

export interface ServerEvents {
    // Lobby responses
    'room:created': (data: { code: string; player: Player; sessionToken: string }) => void;
    'room:joined': (data: {
        code: string;
        player: Player;
        sessionToken: string;
        players: Player[];
        settings: RoomSettings;
    }) => void;
    'room:updated': (data: { players: Player[]; settings: RoomSettings }) => void;
    'room:error': (data: { code: ErrorCode; message: string; suggestedName?: string }) => void;
    'room:kicked': (data?: unknown) => void;
    'room:host_transferred': (data: { newHostId: string; newHostName: string }) => void;
    'room:expired': (data?: unknown) => void;

    // Game flow
    'game:countdown': (data: { seconds: number; expiresAt: number }) => void;
    'game:cancelled': (data?: unknown) => void;
    'game:role': (data: { role: Role; allies?: { id: string; name: string }[] }) => void;
    'game:phase': (data: { phase: Phase; round: number; timerExpiresAt: number | null }) => void;

    // Night
    'game:night_ack': (data: { success: boolean }) => void;
    'game:detective_result': (data: DetectiveEntry) => void;

    // Dawn
    'game:dawn': (data: DawnResult) => void;

    // Day
    'game:vote_count': (data: { votesIn: number; totalVoters: number }) => void;
    'game:vote_extension': (data: { newExpiresAt: number }) => void;
    'game:vote_results': (data: VoteResult) => void;

    // End
    'game:over': (data: GameOverPayload) => void;

    // Reconnection
    'player:reconnected': (data: { gameState: GameState }) => void;
}
