import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMafiaServer, type MafiaServer } from '../app.js';
import { connect as baseConnect, once, type ClientSocket } from './testHelpers.js';

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

describe('room lifecycle', () => {
    it('creates a room and returns a session token + stable playerId', async () => {
        const host = await connect();
        const created = once(host, 'room:created');
        host.emit('room:create', { playerName: 'Host', avatarId: 1 });
        const payload = await created;

        expect(payload.code).toMatch(/^[A-Z0-9]{5}$/);
        expect(payload.sessionToken).toBeTruthy();
        expect(payload.player.name).toBe('Host');
        expect(payload.player.isHost).toBe(true);
        expect(payload.player.id).toBeTruthy();

        host.disconnect();
    });

    it('lets a second player join and broadcasts room:updated to both', async () => {
        const host = await connect();
        const { code } = await (async () => {
            const created = once(host, 'room:created');
            host.emit('room:create', { playerName: 'Host', avatarId: 1 });
            return created;
        })();

        const hostUpdated = once(host, 'room:updated');
        const guest = await connect();
        const joined = once(guest, 'room:joined');
        guest.emit('room:join', { code, playerName: 'Guest', avatarId: 2 });

        const [joinedPayload, updatedPayload] = await Promise.all([joined, hostUpdated]);
        expect(joinedPayload.players).toHaveLength(2);
        expect(updatedPayload.players).toHaveLength(2);
        expect(joinedPayload.player.isHost).toBe(false);

        host.disconnect();
        guest.disconnect();
    });

    it('rejects a duplicate name in the same room', async () => {
        const host = await connect();
        const created = once(host, 'room:created');
        host.emit('room:create', { playerName: 'Dup', avatarId: 1 });
        const { code } = await created;

        const guest = await connect();
        const error = once(guest, 'room:error');
        guest.emit('room:join', { code, playerName: 'dup', avatarId: 2 }); // case-insensitive match
        const err = await error;

        expect(err.code).toBe('duplicate_name');
        expect(err.suggestedName).toBeTruthy();

        host.disconnect();
        guest.disconnect();
    });

    it('rejects joining a nonexistent room code', async () => {
        const guest = await connect();
        const error = once(guest, 'room:error');
        guest.emit('room:join', { code: 'ZZZZZ', playerName: 'Nobody', avatarId: 1 });
        const err = await error;
        expect(err.code).toBe('not_found');
        guest.disconnect();
    });

    it('room:check reports accurate status', async () => {
        const host = await connect();
        const created = once(host, 'room:created');
        host.emit('room:create', { playerName: 'Checker', avatarId: 1 });
        const { code } = await created;

        const status = await new Promise<{ exists: boolean; status: string }>((resolve) => {
            host.emit('room:check', { code }, resolve);
        });
        expect(status).toEqual({ exists: true, status: 'lobby' });

        const missing = await new Promise<{ exists: boolean; status: string }>((resolve) => {
            host.emit('room:check', { code: 'NOPE0' }, resolve);
        });
        expect(missing).toEqual({ exists: false, status: 'not_found' });

        host.disconnect();
    });

    it('transfers host and notifies the room when the host leaves', async () => {
        const host = await connect();
        const created = once(host, 'room:created');
        host.emit('room:create', { playerName: 'Host', avatarId: 1 });
        const { code } = await created;

        const guest = await connect();
        const joined = once(guest, 'room:joined');
        guest.emit('room:join', { code, playerName: 'Successor', avatarId: 2 });
        await joined;

        const transferred = once(guest, 'room:host_transferred');
        host.emit('room:leave');
        const transfer = await transferred;

        expect(transfer.newHostName).toBe('Successor');

        guest.disconnect();
    });

    it('transfers host on a network disconnect in the lobby too, not just an explicit leave', async () => {
        const host = await connect();
        const created = once(host, 'room:created');
        host.emit('room:create', { playerName: 'Host', avatarId: 1 });
        const { code } = await created;

        const guest = await connect();
        const joined = once(guest, 'room:joined');
        guest.emit('room:join', { code, playerName: 'Successor', avatarId: 2 });
        await joined;

        const transferred = once(guest, 'room:host_transferred');
        host.disconnect(); // simulate a dropped connection, not room:leave
        const transfer = await transferred;
        expect(transfer.newHostName).toBe('Successor');

        guest.disconnect();
    });

    it('kick removes the target and they receive room:kicked', async () => {
        const host = await connect();
        const created = once(host, 'room:created');
        host.emit('room:create', { playerName: 'Host', avatarId: 1 });
        const { code } = await created;

        const guest = await connect();
        const joined = once(guest, 'room:joined');
        guest.emit('room:join', { code, playerName: 'Kickee', avatarId: 2 });
        const { player } = await joined;

        const kicked = once(guest, 'room:kicked');
        host.emit('room:kick', { targetId: player.id });
        await kicked; // resolves — no payload assertion needed, event firing is the assertion

        host.disconnect();
        guest.disconnect();
    });

    it('rejects a non-host trying to kick', async () => {
        const host = await connect();
        const created = once(host, 'room:created');
        host.emit('room:create', { playerName: 'Host', avatarId: 1 });
        const { code } = await created;

        const guest = await connect();
        const joined = once(guest, 'room:joined');
        guest.emit('room:join', { code, playerName: 'NotHost', avatarId: 2 });
        await joined;

        const error = once(guest, 'room:error');
        guest.emit('room:kick', { targetId: 'whoever' });
        const err = await error;
        expect(err.code).toBe('not_host');

        host.disconnect();
        guest.disconnect();
    });
});
