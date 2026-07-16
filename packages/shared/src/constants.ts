// ============================================
// MAFIA — Game Constants
// ============================================
// Mirrors the frontend's packages/types/src/index.ts + Sourceoftruth.md §7 exactly.
// ============================================

import type { RoomSettings, Role } from './types.js';

// Room codes
export const ROOM_CODE_LENGTH = 5;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

// Names
export const NAME_MIN_LENGTH = 1;
export const NAME_MAX_LENGTH = 12;
export const NAME_PATTERN = /^[A-Za-z0-9 ]+$/;

// Avatars
export const AVATAR_MIN_ID = 1;
export const AVATAR_MAX_ID = 15;
export const AVATAR_COUNT = 15;

// Player limits
export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 15;

// Timers (seconds) — default values
export const DEFAULT_DISCUSSION_TIMER = 150;
export const DEFAULT_VOTE_TIMER = 10;
export const DEFAULT_NIGHT_TIMER = 10;

// Timer ranges (validate `room:settings`)
export const DISCUSSION_TIMER_OPTIONS = [60, 120, 150, 180, 240, 300];
export const VOTE_TIMER_OPTIONS = [10, 15, 20, 30];
export const NIGHT_TIMER_OPTIONS = [10, 15, 20, 30];

// Default settings (apply on room creation)
export const DEFAULT_SETTINGS: RoomSettings = {
    discussionTimer: DEFAULT_DISCUSSION_TIMER,
    voteTimer: DEFAULT_VOTE_TIMER,
    nightTimer: DEFAULT_NIGHT_TIMER,
    roleRevealOnDeath: true,
    allowHostExtension: true,
    soundEffects: true,
};

// Game phases — fixed durations (seconds)
export const PREGAME_COUNTDOWN_SECONDS = 10;
export const ROLE_REVEAL_GRACE_SECONDS = 20; // server advances even if not all ack
export const DAWN_HOLD_SECONDS = 3;
export const VOTE_RESULTS_HOLD_SECONDS = 3;

// Host extension (discussion phase)
export const HOST_EXTENSION_INCREMENT_SECONDS = 30;
export const MAX_DISCUSSION_TOTAL_SECONDS = 300;

// Voting auto-extension (one-time per voting round)
export const VOTE_AUTO_EXTENSION_SECONDS = 5;

// Reconnection grace (seconds)
export const RECONNECT_GRACE_SECONDS_LOBBY = 30;
export const RECONNECT_GRACE_SECONDS_INGAME = 30;
export const RECONNECT_GRACE_SECONDS_COUNTDOWN = 15;

// Room expiration (seconds)
export const ROOM_IDLE_EXPIRATION_SECONDS = 900; // 15 minutes of no activity
export const EMPTY_ROOM_DESTROY_SECONDS = 300; // 5 minutes with everyone disconnected

// Role distribution: playerCount → { mafia, doctor, detective, villager }
export const ROLE_DISTRIBUTION: Record<number, Record<Role, number>> = {
    5: { mafia: 1, doctor: 1, detective: 1, villager: 2 },
    6: { mafia: 1, doctor: 1, detective: 1, villager: 3 },
    7: { mafia: 2, doctor: 1, detective: 1, villager: 3 },
    8: { mafia: 2, doctor: 1, detective: 1, villager: 4 },
    9: { mafia: 2, doctor: 1, detective: 1, villager: 5 },
    10: { mafia: 3, doctor: 1, detective: 1, villager: 5 },
    11: { mafia: 3, doctor: 1, detective: 1, villager: 6 },
    12: { mafia: 3, doctor: 1, detective: 1, villager: 7 },
    13: { mafia: 4, doctor: 1, detective: 1, villager: 7 },
    14: { mafia: 4, doctor: 1, detective: 1, villager: 8 },
    15: { mafia: 4, doctor: 1, detective: 1, villager: 9 },
};
