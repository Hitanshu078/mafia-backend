import { io, Socket } from 'socket.io-client';
import type { ServerEvents, ClientEvents } from '@mafia/shared';

const SOCKET_URL = 'http://localhost:3001';

function createPlayer(name: string) {
    const socket: Socket<ServerEvents, ClientEvents> = io(SOCKET_URL, { transports: ['websocket'] });

    socket.on('connect', () => {
        console.log(`[${name}] Connected: ${socket.id}`);
    });

    socket.on('room:error', (data) => {
        console.log(`[${name}] ERROR: ${data.message}`);
    });

    socket.on('room:created', (data) => {
        console.log(`[${name}] Room created: ${data.code}`);
    });

    socket.on('room:joined', (data) => {
        console.log(`[${name}] Joined room: ${data.code}, Players: ${data.players.map(p => p.name).join(', ')}`);
    });

    socket.on('room:updated', (data) => {
        console.log(`[${name}] Room updated: ${data.players.length} players`);
    });

    socket.on('game:countdown', (data) => {
        console.log(`[${name}] Countdown: ${data.seconds}`);
    });

    socket.on('game:role', (data) => {
        console.log(`[${name}] *** ROLE: ${data.role} *** ${data.allies ? 'Allies: ' + data.allies.join(', ') : ''}`);
    });

    socket.on('game:phase', (data) => {
        console.log(`[${name}] Phase: ${data.phase} (Round ${data.round})`);
    });

    socket.on('game:night_ack', (data) => {
        console.log(`[${name}] Night action: ${data.success ? 'accepted' : 'rejected'}`);
    });

    socket.on('game:detective_result', (data) => {
        console.log(`[${name}] 🔍 ${data.targetName} is ${data.isMafia ? 'MAFIA!' : 'innocent'}`);
    });

    socket.on('game:dawn', (data) => {
        if (data.killed) {
            console.log(`[${name}] ☠️  ${data.killed.name} was killed! (Role: ${data.killed.role ?? 'hidden'})`);
        } else if (data.saved) {
            console.log(`[${name}] 🛡️  Doctor saved someone! No one died.`);
        } else {
            console.log(`[${name}] 🌅 No one was killed.`);
        }
    });

    socket.on('game:vote_results', (data) => {
        if (data.eliminated) {
            console.log(`[${name}] 🪦 ${data.eliminated.name} was voted out! (Role: ${data.eliminated.role ?? 'hidden'})`);
        } else {
            console.log(`[${name}] 🤷 Tie — no one eliminated`);
        }
    });

    socket.on('game:over', (data) => {
        console.log(`[${name}] 🏆 GAME OVER — ${data.winner.toUpperCase()} WINS!`);
        console.log(`[${name}] Winners: ${data.leaderboard.join(', ')}`);
        console.log(`[${name}] Rounds: ${data.rounds}`);
    });

    socket.on('disconnect', () => {
        console.log(`[${name}] Disconnected`);
    });

    return socket;
}

// ── Simulate a 5-player game ──────────────────────────────────────────────

async function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

async function main() {
    console.log('=== Creating 5 players ===\n');

    const host = createPlayer('Host');
    await sleep(500);

    // Step 1: Host creates room
    const roomCode = await new Promise<string>((resolve) => {
        host.once('room:created', (data) => resolve(data.code));
        host.emit('room:create', { playerName: 'Host', avatarId: 1 });
    });

    console.log(`\n=== Room code: ${roomCode} ===\n`);

    // Step 2: 4 more players join
    const players = ['Alice', 'Bob', 'Charlie', 'Diana'];
    const sockets = [host];

    let avatarId = 2;
    for (const name of players) {
        const s = createPlayer(name);
        await sleep(300);
        s.emit('room:join', { code: roomCode, playerName: name, avatarId: avatarId++ });
        sockets.push(s);
        await sleep(500);
    }

    console.log('\n=== All players joined. Starting game in 2s... ===\n');
    await sleep(2000);

    // Step 3: Host starts game
    host.emit('game:start');

    // Let the game run — the countdown (10s) + role reveal will happen automatically
    // After roles are assigned, you'll see them in the console
    // Night phase will start, and the timer will expire (since no one acts),
    // then discussion, voting timer expires, etc.

    // Keep the script alive for 2 minutes to watch the game play out
    console.log('\n=== Watching game for 2 minutes (Ctrl+C to exit) ===\n');
    await sleep(120_000);

    // Cleanup
    for (const s of sockets) s.disconnect();
    process.exit(0);
}

main().catch(console.error);