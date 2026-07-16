/** Fixed-window rate limiter — enough to blunt an accidental or malicious
 * event flood from a single client without adding a dependency. */
export class RateLimiter {
    private readonly windowMs: number;
    private readonly maxPerWindow: number;
    private counters = new Map<string, { count: number; windowStart: number }>();

    constructor(windowMs: number, maxPerWindow: number) {
        this.windowMs = windowMs;
        this.maxPerWindow = maxPerWindow;
    }

    /** Returns true if this key is still within its allowance for the current window. */
    check(key: string): boolean {
        const now = Date.now();
        const entry = this.counters.get(key);

        if (!entry || now - entry.windowStart >= this.windowMs) {
            this.counters.set(key, { count: 1, windowStart: now });
            return true;
        }

        entry.count++;
        return entry.count <= this.maxPerWindow;
    }

    clear(key: string): void {
        this.counters.delete(key);
    }
}

// Per-socket: generous enough for legitimate rapid clicking (changing a night
// target a few times before confirming, mashing a vote button), tight enough
// to stop a flood.
export const socketEventLimiter = new RateLimiter(10_000, 40);

// Per-IP: room creation is the one action that costs the server real memory
// per call and has no natural rate ceiling from normal play (unlike votes,
// which are capped by room size and phase count). Kept generous — everyone
// in a physical game session is typically behind the same WiFi/NAT, so a
// group replaying several games in one evening shares one IP for all of
// their room:create calls.
export const roomCreateLimiter = new RateLimiter(60_000, 15);
