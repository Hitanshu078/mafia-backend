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

describe('full game flow', () => {
    it(
        'plays a 5-player game through role assignment, night actions, a reconnect, a tied vote, and a decisive win',
        async () => {
            const names = ['Host', 'Alice', 'Bob', 'Charlie', 'Diana'];
            const sockets: Record<string, ClientSocket> = {};
            const playerIds: Record<string, string> = {};
            const sessionTokens: Record<string, string> = {};
            const roles: Record<string, Role> = {};

            const host = await connect();
            sockets.Host = host;

            const created = once(host, 'room:created');
            host.emit('room:create', { playerName: 'Host', avatarId: 1 });
            const createdPayload = await created;
            const code = createdPayload.code;
            playerIds.Host = createdPayload.player.id;
            sessionTokens.Host = createdPayload.sessionToken;

            for (const name of names) {
                if (name === 'Host') continue;
                const s = await connect();
                sockets[name] = s;
                const joined = once(s, 'room:joined');
                s.emit('room:join', { code, playerName: name, avatarId: names.indexOf(name) + 1 });
                const payload = await joined;
                playerIds[name] = payload.player.id;
                sessionTokens[name] = payload.sessionToken;
            }

            expect(Object.keys(playerIds)).toHaveLength(5);

            // Shrink the discussion timer to the minimum allowed so the test
            // doesn't have to sit through the 150s default.
            host.emit('room:settings', { discussionTimer: 60 });

            // Register every player's game:role listener *before* game:start —
            // each socket gets its own single event, and (per a real race this
            // test caught) other sockets' events can still be in-flight when
            // the host's own phase transition fires, so waiting on the host
            // alone as a proxy for "everyone has their role" is not safe.
            const rolePromises = Promise.all(
                names.map((name) => once(sockets[name], 'game:role').then((p) => { roles[name] = p.role; })),
            );

            host.emit('game:start');
            await waitForPhase(host, 'countdown');
            await waitForPhase(host, 'role_reveal');
            await rolePromises;

            expect(new Set(Object.values(roles))).toEqual(new Set(['villager', 'mafia', 'doctor', 'detective']));
            const mafiaName = Object.keys(roles).find((n) => roles[n] === 'mafia')!;
            const doctorName = Object.keys(roles).find((n) => roles[n] === 'doctor')!;
            const detectiveName = Object.keys(roles).find((n) => roles[n] === 'detective')!;
            const villagerNames = Object.keys(roles).filter((n) => roles[n] === 'villager');

            await waitForPhase(host, 'night');

            // --- Round 1 night: mafia kills a villager, doctor protects the
            // other villager (no overlap -> the kill lands), detective
            // investigates the mafia (round-trip sanity check on the result).
            const victim1 = villagerNames[0];
            const protectedPlayer = villagerNames[1];

            // Register both listeners *before* emitting any action — dawn can
            // fire in the same server tick as the detective's result once the
            // last of the three required actions lands, so registering it
            // afterwards risks missing the broadcast.
            const detectiveResult = once(sockets[detectiveName], 'game:detective_result');
            const dawnPromise = once(host, 'game:dawn');

            sockets[mafiaName].emit('game:night_action', { targetId: playerIds[victim1] });
            sockets[doctorName].emit('game:night_action', { targetId: playerIds[protectedPlayer] });
            sockets[detectiveName].emit('game:night_action', { targetId: playerIds[mafiaName] });

            const [detResult, dawn] = await Promise.all([detectiveResult, dawnPromise]);
            expect(detResult.isMafia).toBe(true);
            expect(detResult.targetName).toBe(mafiaName);
            expect(dawn.killed?.name).toBe(victim1);
            expect(dawn.saved).toBe(false);

            await waitForPhase(host, 'discussion');

            // --- Mid-game reconnect check: the detective drops off and comes
            // back via player:rejoin — must resume as the SAME playerId.
            const detectiveDisconnected = once(host, 'room:updated');
            sockets[detectiveName].disconnect();
            const afterDisconnect = await detectiveDisconnected;
            const detectiveInList = afterDisconnect.players.find((p) => p.id === playerIds[detectiveName]);
            expect(detectiveInList?.isConnected).toBe(false);

            const reconnectedSocket = await connect();
            const reconnected = once(reconnectedSocket, 'player:reconnected');
            reconnectedSocket.emit('player:rejoin', { sessionToken: sessionTokens[detectiveName] });
            const reconnectPayload = await reconnected;
            const meAfterReconnect = reconnectPayload.gameState.players.find((p) => p.id === playerIds[detectiveName]);
            expect(meAfterReconnect?.isConnected).toBe(true);
            expect(reconnectPayload.gameState.myRole).toBe('detective');
            sockets[detectiveName] = reconnectedSocket; // continue the game on the new socket

            // --- Everyone alive votes to force a tie (4 alive after round 1's
            // kill). discussionTimer was shrunk to its 60s minimum above —
            // extend_timer itself is covered by the engine's unit-level logic
            // and manual/browser verification, not repeated here to keep this
            // already-long real-timer test under a couple of minutes.
            const alive1 = names.filter((n) => n !== victim1);
            expect(alive1).toHaveLength(4);

            await waitForPhase(host, 'voting');

            // 2-2 split → tie, nobody eliminated.
            const [a, b, c, d] = alive1;
            const voteResults = once(host, 'game:vote_results');
            sockets[a].emit('game:vote', { targetId: playerIds[c] });
            sockets[b].emit('game:vote', { targetId: playerIds[c] });
            sockets[c].emit('game:vote', { targetId: playerIds[a] });
            sockets[d].emit('game:vote', { targetId: playerIds[a] });
            const tieResult = await voteResults;
            expect(tieResult.tie).toBe(true);
            expect(tieResult.eliminated).toBeNull();

            // --- Round 2 night: mafia kills the other villager, doctor no
            // longer protects the same target as last time (protectedPlayer),
            // detective investigates again — leaves mafia/doctor/detective alive.
            await waitForPhase(host, 'night');
            const remainingVillager = villagerNames.find((v) => v !== victim1)!;

            sockets[mafiaName].emit('game:night_action', { targetId: playerIds[remainingVillager] });
            sockets[doctorName].emit('game:night_action', { targetId: playerIds[doctorName] }); // self-protect, allowed
            sockets[detectiveName].emit('game:night_action', { targetId: playerIds[doctorName] });

            await waitForPhase(host, 'discussion');
            await waitForPhase(host, 'voting');

            // Doctor + detective both vote out the mafia -> city wins.
            const gameOver = once(host, 'game:over');
            sockets[doctorName].emit('game:vote', { targetId: playerIds[mafiaName] });
            sockets[detectiveName].emit('game:vote', { targetId: playerIds[mafiaName] });
            sockets[mafiaName].emit('game:vote', { targetId: playerIds[doctorName] });

            const summary = await gameOver;
            expect(summary.winner).toBe('city');
            expect(summary.roles[playerIds[mafiaName]]).toBe('mafia');
            expect(summary.roles[playerIds[doctorName]]).toBe('doctor');
            expect(summary.leaderboard).toContain(playerIds[doctorName]);
            expect(summary.leaderboard).toContain(playerIds[detectiveName]);
            expect(summary.leaderboard).not.toContain(playerIds[mafiaName]);

            for (const s of Object.values(sockets)) s.disconnect();
        },
        220_000,
    );
});
