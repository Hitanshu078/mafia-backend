// ============================================
// MAFIA — Zod Schemas (wire contract)
// ============================================
// Mirrors the frontend's packages/types/src/index.ts exactly.
// If you change a payload shape here, both sides show type errors until updated.
// ============================================

import { z } from 'zod';

export const RoleSchema = z.enum(['villager', 'mafia', 'doctor', 'detective']);

export const PhaseSchema = z.enum([
    'lobby',
    'countdown',
    'role_reveal',
    'night',
    'dawn',
    'discussion',
    'voting',
    'vote_results',
    'game_over',
]);

export const WinnerSchema = z.enum(['city', 'mafia']);

export const ConnectionStatusSchema = z.enum(['connecting', 'connected', 'disconnected', 'reconnecting']);

export const ErrorCodeSchema = z.enum([
    'not_found',
    'full',
    'in_progress',
    'duplicate_name',
    'rate_limit',
    'invalid_action',
    'not_host',
    'not_alive',
    'generic',
]);

export const PlayerSchema = z.object({
    id: z.string(),
    name: z.string(),
    avatarId: z.number(),
    isAlive: z.boolean(),
    isHost: z.boolean(),
    isConnected: z.boolean(),
    role: RoleSchema.optional(),
});

export const RoomSettingsSchema = z.object({
    discussionTimer: z.number(),
    voteTimer: z.number(),
    roleRevealOnDeath: z.boolean(),
    allowHostExtension: z.boolean(),
    soundEffects: z.boolean(),
});

export const DawnResultSchema = z.object({
    killed: z.object({ id: z.string(), name: z.string(), role: RoleSchema.optional() }).nullable(),
    saved: z.boolean(),
});

export const VoteResultSchema = z.object({
    tally: z.record(z.string(), z.array(z.string())),
    eliminated: z.object({ id: z.string(), name: z.string(), role: RoleSchema.optional() }).nullable(),
    tie: z.boolean(),
    allAbstained: z.boolean(),
});

export const GameStateSchema = z.object({
    phase: PhaseSchema,
    round: z.number(),
    timerExpiresAt: z.number().nullable(),
    players: z.array(PlayerSchema),
    settings: RoomSettingsSchema,
    myRole: RoleSchema.optional(),
    myAllies: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
    doctorLastProtected: z.string().nullable().optional(),
});

export const GameOverPayloadSchema = z.object({
    winner: WinnerSchema,
    roles: z.record(z.string(), RoleSchema),
    leaderboard: z.array(z.string()),
    rounds: z.number(),
});

export const DetectiveEntrySchema = z.object({
    round: z.number(),
    targetId: z.string(),
    targetName: z.string(),
    isMafia: z.boolean(),
});

// ---- CLIENT → SERVER ----
// Name/avatar/settings bounds are duplicated as literals here (rather than
// imported from ./constants.js) to avoid a schemas.ts → constants.ts →
// types.ts → schemas.ts import cycle. Keep in sync with ./constants.ts.

const NamePayloadSchema = z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9 ]+$/);
const AvatarIdSchema = z.number().int().min(1).max(15);

export const ClientEventsSchema = {
    'room:create': z.object({ playerName: NamePayloadSchema, avatarId: AvatarIdSchema }),
    'room:join': z.object({ code: z.string().length(5), playerName: NamePayloadSchema, avatarId: AvatarIdSchema }),
    'room:leave': z.undefined(),
    'room:kick': z.object({ targetId: z.string() }),
    'room:settings': RoomSettingsSchema.partial(),
    'room:check': z.object({ code: z.string().length(5) }),
    'game:start': z.undefined(),
    'game:cancel_start': z.undefined(),
    'game:acknowledge_role': z.undefined(),
    // targetId: null means "retract my current selection" — night/vote
    // choices are freely changeable until the round resolves.
    'game:night_action': z.object({ targetId: z.string().nullable() }),
    'game:vote': z.object({ targetId: z.string().nullable() }),
    'game:extend_timer': z.undefined(),
    'game:end_discussion': z.undefined(),
    'game:play_again': z.undefined(),
    'player:rejoin': z.object({ sessionToken: z.string() }),
} as const;

export type ClientEventPayloads = {
    [K in keyof typeof ClientEventsSchema]: z.infer<typeof ClientEventsSchema[K]>;
};

// ---- SERVER → CLIENT ----

export const ServerEventsSchema = {
    'room:created': z.object({
        code: z.string(),
        player: PlayerSchema,
        sessionToken: z.string(),
    }),
    'room:joined': z.object({
        code: z.string(),
        player: PlayerSchema,
        sessionToken: z.string(),
        players: z.array(PlayerSchema),
        settings: RoomSettingsSchema,
    }),
    'room:updated': z.object({
        players: z.array(PlayerSchema),
        settings: RoomSettingsSchema,
    }),
    'room:error': z.object({
        code: ErrorCodeSchema,
        message: z.string(),
        suggestedName: z.string().optional(),
    }),
    'room:kicked': z.any(),
    'room:host_transferred': z.object({
        newHostId: z.string(),
        newHostName: z.string(),
    }),
    'room:expired': z.any(),
    'game:countdown': z.object({
        seconds: z.number(),
        expiresAt: z.number(),
    }),
    'game:cancelled': z.any(),
    'game:role': z.object({
        role: RoleSchema,
        allies: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
    }),
    'game:phase': z.object({
        phase: PhaseSchema,
        round: z.number(),
        timerExpiresAt: z.number().nullable(),
    }),
    'game:night_ack': z.object({
        success: z.boolean(),
    }),
    'game:dawn': DawnResultSchema,
    'game:detective_result': DetectiveEntrySchema,
    'game:vote_count': z.object({
        votesIn: z.number(),
        totalVoters: z.number(),
    }),
    'game:vote_extension': z.object({
        newExpiresAt: z.number(),
    }),
    'game:vote_results': VoteResultSchema,
    'game:over': GameOverPayloadSchema,
    'player:reconnected': z.object({
        gameState: GameStateSchema,
    }),
} as const;

export type ServerEventPayloads = {
    [K in keyof typeof ServerEventsSchema]: z.infer<typeof ServerEventsSchema[K]>;
};
