import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Role } from '@mafia/shared';
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

describe('timer-less night phase, auto-abstain voting, end discussion, and play again', () => {
    it(
        'skips a dead role in night, auto-abstains a silent voter, ends discussion on host command, and play_again resets every client to lobby',
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

            // Minimum-allowed timers: discussion is skipped via the End
            // Discussion button anyway; voting needs to actually run its
            // course once to exercise the auto-abstain path.
            host.emit('room:settings', { discussionTimer: 15, voteTimer: 15 });

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

            // --- Round 1 night: mafia kills the doctor directly (protecting
            // someone else instead of themselves), so the doctor role is dead
            // going into round 2 — the redesigned night phase must then skip
            // waiting on a doctor action entirely.
            await waitForPhase(host, 'night');
            const dawn1 = once(host, 'game:dawn');
            sockets[mafiaName].emit('game:night_action', { targetId: playerIds[doctorName] });
            sockets[doctorName].emit('game:night_action', { targetId: playerIds[villager1] });
            sockets[detectiveName].emit('game:night_action', { targetId: playerIds[mafiaName] });
            const dawn = await dawn1;
            expect(dawn.killed?.name).toBe(doctorName);

            // --- Host ends discussion immediately instead of waiting out the timer.
            await waitForPhase(host, 'discussion');
            const votingPhase = waitForPhase(host, 'voting', 10_000);
            host.emit('game:end_discussion');
            await votingPhase;

            // --- Round 1 voting: 3 of the 4 alive players vote, one (villager2)
            // stays silent and must be auto-recorded as an abstain once the
            // timer (plus the one-time auto-extension) elapses.
            const voteResults = once(host, 'game:vote_results');
            sockets[mafiaName].emit('game:vote', { targetId: playerIds[villager1] });
            sockets[detectiveName].emit('game:vote', { targetId: playerIds[villager1] });
            sockets[villager1].emit('game:vote', { targetId: playerIds[detectiveName] });
            const result = await voteResults;

            expect(result.eliminated?.name).toBe(villager1);
            expect(result.tie).toBe(false);
            expect(result.tally['abstain']).toContain(playerIds[villager2]);

            // --- Round 2 night: doctor is dead, so only mafia + detective act.
            // If the redesigned engine incorrectly still waited on the dead
            // doctor, this would hang until the test's own timeout fired.
            await waitForPhase(host, 'night');
            const dawn2 = once(host, 'game:dawn');
            sockets[mafiaName].emit('game:night_action', { targetId: playerIds[villager2] });
            sockets[detectiveName].emit('game:night_action', { targetId: playerIds[mafiaName] });
            await dawn2;

            // Mafia (1) now equals remaining city (detective) -> mafia wins.
            const gameOver = once(host, 'game:over');
            const summary = await gameOver;
            expect(summary.winner).toBe('mafia');

            // --- Play Again must move every connected client back to the
            // lobby, not just update the room roster.
            const hostBackToLobby = waitForPhase(host, 'lobby', 5_000);
            const detectiveBackToLobby = waitForPhase(sockets[detectiveName], 'lobby', 5_000);
            host.emit('game:play_again');
            await Promise.all([hostBackToLobby, detectiveBackToLobby]);

            for (const s of Object.values(sockets)) s.disconnect();
        },
        // Fixed-duration server waits alone (countdown 10s + role-reveal grace
        // 20s + two dawn holds + vote-results hold + one full voting round
        // with its auto-extension) add up to ~55-60s before any assertions
        // even run — give this real-timer test comfortable headroom.
        90_000,
    );
});

describe('room:settings timer validation', () => {
    it('silently rejects out-of-range or off-step timer values while accepting valid ones', async () => {
        const host = await connect();
        const created = once(host, 'room:created');
        host.emit('room:create', { playerName: 'Solo', avatarId: 1 });
        await created;

        // Both invalid — below the 15s minimum, and not a multiple of the
        // 15s step — produce no broadcast at all (handled synchronously
        // before the valid emit below, over the same connection).
        host.emit('room:settings', { discussionTimer: 10 });
        host.emit('room:settings', { voteTimer: 22 });

        const applied = once(host, 'room:updated');
        host.emit('room:settings', { voteTimer: 30 });
        const updated = await applied;

        // discussionTimer never touched by the rejected 10 -> still the default.
        expect(updated.settings.discussionTimer).toBe(150);
        expect(updated.settings.voteTimer).toBe(30);

        host.disconnect();
    });
});
