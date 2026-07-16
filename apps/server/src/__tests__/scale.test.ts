import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ROLE_DISTRIBUTION, MAX_PLAYERS } from '@mafia/shared';
import { createMafiaServer, type MafiaServer } from '../app.js';
import { connect as baseConnect, once, waitForPhase, type ClientSocket } from './testHelpers.js';

let server: MafiaServer;
let baseUrl: string;

function connect(): Promise<ClientSocket> {
    return baseConnect(baseUrl);
}

beforeAll(async () => {
    server = await createMafiaServer(0, 'http://localhost:5173');
    baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
    await server.close();
});

describe('scale: 10-15 player games', () => {
    it(`fills a room to MAX_PLAYERS (${MAX_PLAYERS}), rejects the next join, and assigns roles correctly on start`, async () => {
        const host = await connect();
        const created = once(host, 'room:created');
        host.emit('room:create', { playerName: 'Player0', avatarId: 1 });
        const { code } = await created;

        const sockets: ClientSocket[] = [host];
        const roleCounts: Record<string, number> = { villager: 0, mafia: 0, doctor: 0, detective: 0 };

        // Fill the room to capacity (host + 14 more = 15 = MAX_PLAYERS).
        for (let i = 1; i < MAX_PLAYERS; i++) {
            const s = await connect();
            const joined = once(s, 'room:joined');
            s.emit('room:join', { code, playerName: `Player${i}`, avatarId: (i % 15) + 1 });
            const payload = await joined;
            expect(payload.players).toHaveLength(i + 1);
            sockets.push(s);
        }

        expect(sockets).toHaveLength(MAX_PLAYERS);

        // The 16th player must be rejected as full.
        const overflow = await connect();
        const overflowError = once(overflow, 'room:error');
        overflow.emit('room:join', { code, playerName: 'OneTooMany', avatarId: 1 });
        const err = await overflowError;
        expect(err.code).toBe('full');
        overflow.disconnect();

        // Every seated player captures their assigned role.
        const rolePromises = Promise.all(sockets.map((s) => once(s, 'game:role')));

        host.emit('game:start');
        await waitForPhase(host, 'countdown');
        await waitForPhase(host, 'role_reveal');
        const roles = await rolePromises;

        expect(roles).toHaveLength(MAX_PLAYERS);
        for (const r of roles) roleCounts[r.role]++;

        // Matches the fixed distribution table for a full 15-player room.
        expect(roleCounts).toEqual(ROLE_DISTRIBUTION[MAX_PLAYERS]);

        // Night phase must actually start for a room this size (no crash in
        // assignRoles/beginRoleReveal at the upper bound).
        await waitForPhase(host, 'night');

        for (const s of sockets) s.disconnect();
    }, 60_000);

    it('plays through role assignment for a 12-player room (mid-range size)', async () => {
        const PLAYER_COUNT = 12;
        const host = await connect();
        const created = once(host, 'room:created');
        host.emit('room:create', { playerName: 'Host', avatarId: 1 });
        const { code } = await created;

        const sockets: ClientSocket[] = [host];
        for (let i = 1; i < PLAYER_COUNT; i++) {
            const s = await connect();
            const joined = once(s, 'room:joined');
            s.emit('room:join', { code, playerName: `P${i}`, avatarId: (i % 15) + 1 });
            await joined;
            sockets.push(s);
        }
        expect(sockets).toHaveLength(PLAYER_COUNT);

        const rolePromises = Promise.all(sockets.map((s) => once(s, 'game:role')));
        host.emit('game:start');
        await waitForPhase(host, 'countdown');
        await waitForPhase(host, 'role_reveal');
        const roles = await rolePromises;

        const roleCounts: Record<string, number> = { villager: 0, mafia: 0, doctor: 0, detective: 0 };
        for (const r of roles) roleCounts[r.role]++;
        expect(roleCounts).toEqual(ROLE_DISTRIBUTION[PLAYER_COUNT]);

        for (const s of sockets) s.disconnect();
    }, 60_000);
});
