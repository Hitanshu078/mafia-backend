import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Role } from '@mafia/shared';
import { createMafiaServer, type MafiaServer } from '../app.js';
import { connect as baseConnect, once, waitForPhase, type ClientSocket } from './testHelpers.js';

let server: MafiaServer;
let baseUrl: string;

function connect(): Promise<ClientSocket> {
    return baseConnect(baseUrl);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
    server = await createMafiaServer(0, 'http://localhost:5173');
    baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
    await server.close();
});

describe('freely-changeable target/vote selection (no premature lock-in)', () => {
    it(
        "mafia can retract and switch their night target — only the final target lands, and the round does not resolve while mafia's action is retracted",
        async () => {
            const names = ['Host', 'Alice', 'Bob', 'Charlie', 'Diana'];
            const sockets: Record<string, ClientSocket> = {};
            const playerIds: Record<string, string> = {};
            const roles: Record<string, Role> = {};

            const host = await connect();
            sockets.Host = host;
            const created = once(host, 'room:created');
            host.emit('room:create', { playerName: 'Host', avatarId: 1 });
            const createdPayload = await created;
            const code = createdPayload.code;
            playerIds.Host = createdPayload.player.id;

            for (const name of names) {
                if (name === 'Host') continue;
                const s = await connect();
                sockets[name] = s;
                const joined = once(s, 'room:joined');
                s.emit('room:join', { code, playerName: name, avatarId: names.indexOf(name) + 1 });
                const payload = await joined;
                playerIds[name] = payload.player.id;
            }

            const rolePromises = Promise.all(
                names.map((name) => once(sockets[name], 'game:role').then((p) => { roles[name] = p.role; })),
            );

            host.emit('game:start');
            await waitForPhase(host, 'countdown');
            await waitForPhase(host, 'role_reveal');
            await rolePromises;

            const mafiaName = Object.keys(roles).find((n) => roles[n] === 'mafia')!;
            const doctorName = Object.keys(roles).find((n) => roles[n] === 'doctor')!;
            const detectiveName = Object.keys(roles).find((n) => roles[n] === 'detective')!;
            const [villager1, villager2] = Object.keys(roles).filter((n) => roles[n] === 'villager');

            await waitForPhase(host, 'night');

            let dawnFired = false;
            const dawnPromise = once(host, 'game:dawn').then((r) => { dawnFired = true; return r; });

            // Mafia picks villager1, then changes their mind entirely.
            sockets[mafiaName].emit('game:night_action', { targetId: playerIds[villager1] });
            sockets[mafiaName].emit('game:night_action', { targetId: null }); // retract

            // Doctor and detective both complete their actions while mafia's
            // choice is retracted — the round must NOT resolve yet, since
            // mafia (alive) has no recorded action.
            sockets[doctorName].emit('game:night_action', { targetId: playerIds[villager1] });
            sockets[detectiveName].emit('game:night_action', { targetId: playerIds[mafiaName] });

            await sleep(1200);
            expect(dawnFired).toBe(false);

            // Mafia now commits to villager2 — this should be the only
            // target that ever lands, not the earlier villager1 pick.
            sockets[mafiaName].emit('game:night_action', { targetId: playerIds[villager2] });

            const dawn = await dawnPromise;
            expect(dawn.killed?.name).toBe(villager2);

            for (const s of Object.values(sockets)) s.disconnect();
        },
        // Countdown (10s) + role-reveal grace (20s) alone are ~30s before
        // night even starts — give this comfortable headroom.
        45_000,
    );

    it(
        'a voter can retract and switch their vote — only their final choice is tallied, not an earlier or stale pick',
        async () => {
            const names = ['Host', 'Alice', 'Bob', 'Charlie', 'Diana'];
            const sockets: Record<string, ClientSocket> = {};
            const playerIds: Record<string, string> = {};
            const roles: Record<string, Role> = {};

            const host = await connect();
            sockets.Host = host;
            const created = once(host, 'room:created');
            host.emit('room:create', { playerName: 'Host', avatarId: 1 });
            const createdPayload = await created;
            const code = createdPayload.code;
            playerIds.Host = createdPayload.player.id;

            for (const name of names) {
                if (name === 'Host') continue;
                const s = await connect();
                sockets[name] = s;
                const joined = once(s, 'room:joined');
                s.emit('room:join', { code, playerName: name, avatarId: names.indexOf(name) + 1 });
                const payload = await joined;
                playerIds[name] = payload.player.id;
            }

            const rolePromises = Promise.all(
                names.map((name) => once(sockets[name], 'game:role').then((p) => { roles[name] = p.role; })),
            );

            host.emit('game:start');
            await waitForPhase(host, 'countdown');
            await waitForPhase(host, 'role_reveal');
            await rolePromises;

            const mafiaName = Object.keys(roles).find((n) => roles[n] === 'mafia')!;
            const doctorName = Object.keys(roles).find((n) => roles[n] === 'doctor')!;
            const detectiveName = Object.keys(roles).find((n) => roles[n] === 'detective')!;
            const [villager1, villager2] = Object.keys(roles).filter((n) => roles[n] === 'villager');

            // Round 1 night: mafia kills villager1 outright (doctor protects
            // the other villager, detective inspects for a sanity round-trip)
            // so voting starts with exactly 4 alive: mafia, doctor, detective, villager2.
            await waitForPhase(host, 'night');
            const dawnPromise = once(host, 'game:dawn');
            sockets[mafiaName].emit('game:night_action', { targetId: playerIds[villager1] });
            sockets[doctorName].emit('game:night_action', { targetId: playerIds[villager2] });
            sockets[detectiveName].emit('game:night_action', { targetId: playerIds[mafiaName] });
            await dawnPromise;

            await waitForPhase(host, 'discussion');
            const votingPhase = waitForPhase(host, 'voting', 10_000);
            host.emit('game:end_discussion');
            await votingPhase;

            // Doctor (the "changer") flip-flops before anyone else votes:
            // detective -> villager2 -> retract -> villager2 (final).
            // If the retract or the switch didn't actually take effect
            // server-side, doctor's vote would still be sitting on
            // "detective", which — combined with the fixed votes below —
            // would produce a 2-2 tie instead of a clean villager2 majority.
            sockets[doctorName].emit('game:vote', { targetId: playerIds[detectiveName] });
            sockets[doctorName].emit('game:vote', { targetId: playerIds[villager2] });
            sockets[doctorName].emit('game:vote', { targetId: null });
            sockets[doctorName].emit('game:vote', { targetId: playerIds[villager2] });

            await sleep(300); // let the flip-flopping settle before the deciding votes land

            const voteResults = once(host, 'game:vote_results');
            sockets[mafiaName].emit('game:vote', { targetId: playerIds[villager2] });
            sockets[detectiveName].emit('game:vote', { targetId: playerIds[villager2] });
            sockets[villager2].emit('game:vote', { targetId: playerIds[detectiveName] });

            const result = await voteResults;
            expect(result.tie).toBe(false);
            expect(result.eliminated?.name).toBe(villager2);
            expect(result.tally[playerIds[villager2]]).toHaveLength(3);

            for (const s of Object.values(sockets)) s.disconnect();
        },
        // Same fixed-duration baseline as above, plus a dawn hold and the
        // discussion->voting hop.
        45_000,
    );
});
