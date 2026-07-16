// ============================================
// MAFIA — Shared Types
// ============================================
// Mirrors the frontend's packages/types/src/index.ts contract exactly.
// Zod schemas live in ./schemas.ts; these are the inferred TS types.
// ============================================

import { z } from 'zod';
import {
    RoleSchema,
    PhaseSchema,
    WinnerSchema,
    ConnectionStatusSchema,
    ErrorCodeSchema,
    PlayerSchema,
    RoomSettingsSchema,
    DawnResultSchema,
    VoteResultSchema,
    GameStateSchema,
    GameOverPayloadSchema,
    DetectiveEntrySchema,
} from './schemas.js';

export type Role = z.infer<typeof RoleSchema>;
export type Phase = z.infer<typeof PhaseSchema>;
export type Winner = z.infer<typeof WinnerSchema>;
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type Player = z.infer<typeof PlayerSchema>;
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;
export type DawnResult = z.infer<typeof DawnResultSchema>;
export type VoteResult = z.infer<typeof VoteResultSchema>;
export type GameState = z.infer<typeof GameStateSchema>;
export type GameOverPayload = z.infer<typeof GameOverPayloadSchema>;
export type DetectiveEntry = z.infer<typeof DetectiveEntrySchema>;
