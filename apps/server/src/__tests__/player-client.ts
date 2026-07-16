import { io, Socket } from 'socket.io-client';
import type { ServerEvents, ClientEvents, Player } from '@mafia/shared';
import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SOCKET_URL = process.env.MAFIA_SOCKET_URL ?? 'http://localhost:3001';
export const ROOM_CODE_FILE = path.join(os.tmpdir(), 'mafia-room-code.txt');

const [, , playerName] = process.argv;

if (!playerName) {
    console.error('Usage: tsx player-client.ts <playerName>');
    process.exit(1);
}

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const R = '\x1b[0m';
const B = '\x1b[1m';
const red = (s: string) => `\x1b[31m${s}${R}`;
const green = (s: string) => `\x1b[32m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;
const blue = (s: string) => `\x1b[34m${s}${R}`;
const magenta = (s: string) => `\x1b[35m${s}${R}`;
const cyan = (s: string) => `\x1b[36m${s}${R}`;
const bold = (s: string) => `${B}${s}${R}`;

function roleColor(role: string): (s: string) => string {
    switch (role) {
        case 'mafia': return red;
        case 'doctor': return green;
        case 'detective': return blue;
        default: return (s) => s;
    }
}

function banner(text: string, color: (s: string) => string = cyan) {
    const line = '═'.repeat(text.length + 4);
    print(color(`╔${line}╗`));
    print(color(`║  ${bold(text)}  ║`));
    print(color(`╚${line}╝`));
}

// ── State ─────────────────────────────────────────────────────────────────────
let myRole: string | null = null;
let myId: string | null = null; // stable playerId, not socket.id
let sessionToken: string | null = null;
let isHost = false;
let currentPhase = 'lobby';
let players: Player[] = [];
let isAlive = true;
let gameStarted = false;

const sessionFile = path.join(os.tmpdir(), `mafia-session-${playerName.toLowerCase()}.json`);

// ── Readline ──────────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
    return new Promise(resolve => rl.question(question, resolve));
}

function prompt() {
    if (!gameStarted) return;
    const phase = cyan(`[${currentPhase}]`);
    const alive = isAlive ? '' : red(' [DEAD]');
    rl.setPrompt(`${phase}${alive} > `);
    rl.prompt(true);
}

function print(msg: string) {
    process.stdout.write(`\r\x1b[K${msg}\n`);
    prompt();
}

function listAlivePlayers() {
    const alive = players.filter(p => p.isAlive && p.id !== myId).map(p => p.name);
    print(cyan(`Targetable players: ${alive.join(', ') || 'none'}`));
}

function randomAvatarId(): number {
    return Math.floor(Math.random() * 15) + 1;
}

function saveSession() {
    if (sessionToken) fs.writeFileSync(sessionFile, JSON.stringify({ sessionToken }), 'utf8');
}

function loadStoredSessionToken(): string | null {
    try {
        const raw = fs.readFileSync(sessionFile, 'utf8');
        return JSON.parse(raw).sessionToken ?? null;
    } catch {
        return null;
    }
}

// ── Socket ────────────────────────────────────────────────────────────────────
const socket: Socket<ServerEvents, ClientEvents> = io(SOCKET_URL, { transports: ['websocket'] });

socket.on('connect', async () => {
    banner(`${playerName}`, cyan);

    const choice = await ask(bold('  (c) Create room    (j) Join room    (r) Rejoin last session\n  > '));

    if (choice.trim().toLowerCase() === 'c') {
        isHost = true;
        socket.emit('room:create', { playerName, avatarId: randomAvatarId() });
    } else if (choice.trim().toLowerCase() === 'r') {
        const token = loadStoredSessionToken();
        if (!token) {
            print(red('No stored session found for this name.'));
            process.exit(1);
        }
        gameStarted = true;
        socket.emit('player:rejoin', { sessionToken: token });
    } else {
        const code = await ask(bold('  Enter room code: '));
        socket.emit('room:join', { code: code.trim().toUpperCase(), playerName, avatarId: randomAvatarId() });
    }
});

socket.on('room:created', (data) => {
    gameStarted = true;
    myId = data.player.id;
    sessionToken = data.sessionToken;
    saveSession();
    print('');
    print(bold(yellow(`  ┌─────────────────────────┐`)));
    print(bold(yellow(`  │   ROOM CODE:  ${data.code}   │`)));
    print(bold(yellow(`  └─────────────────────────┘`)));
    print(cyan('  Share this code with other players.'));
    print(cyan('  Type "start" when everyone has joined.'));
    fs.writeFileSync(ROOM_CODE_FILE, data.code, 'utf8');
    prompt();
});

socket.on('room:joined', (data) => {
    gameStarted = true;
    myId = data.player.id;
    sessionToken = data.sessionToken;
    saveSession();
    players = data.players;
    print(green(`Joined room ${bold(data.code)}`));
    print(cyan(`Players: ${players.map(p => p.name).join(', ')}`));
    print(cyan('Waiting for host to start...'));
    prompt();
});

socket.on('room:updated', (data) => {
    players = data.players;
    const me = players.find(p => p.id === myId);
    if (me) isAlive = me.isAlive;
    const list = players.map(p =>
        `${p.isAlive ? p.name : red(p.name + ' [dead]')}` +
        (p.isHost ? yellow(' [host]') : '') +
        (!p.isConnected ? yellow(' [reconnecting]') : '') +
        (p.id === myId ? bold(' (you)') : '')
    ).join(', ');
    if (me) isHost = me.isHost;
    print(cyan(`Players: ${list}`));
});

socket.on('room:error', (data) => {
    print(red(`ERROR [${data.code}]: ${data.message}`));
});

socket.on('room:kicked', () => {
    print(red('You were kicked from the room.'));
    process.exit(0);
});

socket.on('room:host_transferred', (data) => {
    isHost = data.newHostId === myId;
    print(yellow(`${bold(data.newHostName)} is now the host.`));
    prompt();
});

socket.on('game:countdown', (data) => {
    currentPhase = 'countdown';
    print(yellow(`Game starting in ${bold(String(data.seconds))}s...`));
    if (isHost) print(cyan('Type "cancel" to abort.'));
    prompt();
});

socket.on('game:cancelled', () => {
    currentPhase = 'lobby';
    print(yellow('Game start cancelled.'));
    prompt();
});

socket.on('game:role', (data) => {
    myRole = data.role;
    currentPhase = 'role_reveal';
    const paint = roleColor(data.role);
    banner(`YOUR ROLE: ${data.role.toUpperCase()}`, paint);

    const descriptions: Record<string, string> = {
        mafia:     'Kill one villager each night. Blend in during the day.',
        doctor:    'Save one player from death each night.',
        detective: 'Investigate one player each night.',
        villager:  'Find and vote out the mafia through discussion.',
    };
    print(paint(descriptions[data.role] ?? ''));

    if (data.allies && data.allies.length > 0) {
        const allyNames = data.allies.map(a => a.name).join(', ');
        print(red(`Your mafia allies: ${bold(allyNames)}`));
    }

    print(cyan('Type "ack" to acknowledge your role and proceed.'));
    prompt();
});

socket.on('game:phase', (data) => {
    currentPhase = data.phase;
    print(`\n${magenta(bold(`─── ${data.phase.toUpperCase()}  (Round ${data.round}) ───`))}`);

    if (data.phase === 'night') {
        if (!isAlive) {
            print(red('You are dead. Watch silently.'));
        } else if (myRole === 'villager') {
            print(cyan('You have no night action. Wait for dawn.'));
        } else if (myRole === 'mafia') {
            listAlivePlayers();
            print(cyan('Type "act <name>" to choose your kill target.'));
        } else if (myRole === 'doctor') {
            print(cyan(`Players: ${players.map(p => p.name).join(', ')}`));
            print(cyan('Type "act <name>" to protect a player.'));
        } else if (myRole === 'detective') {
            listAlivePlayers();
            print(cyan('Type "act <name>" to investigate a player.'));
        }
    } else if (data.phase === 'discussion') {
        print(cyan('Discuss who you think is mafia.'));
        if (isHost) print(cyan('Type "extend" to add 30s to the timer.'));
    } else if (data.phase === 'voting') {
        if (isAlive) {
            listAlivePlayers();
            print(cyan('Type "vote <name>" to eliminate someone.'));
        }
    }
    prompt();
});

socket.on('game:night_ack', (data) => {
    print(data.success ? green('Night action submitted.') : red('Invalid target. Try again.'));
});

socket.on('game:detective_result', (data) => {
    const verdict = data.isMafia ? red('MAFIA!') : green('innocent');
    print(blue(`Investigation: ${bold(data.targetName)} is ${verdict}`));
});

socket.on('game:dawn', (data) => {
    print(yellow(bold('\n─── DAWN ───')));
    if (data.killed) {
        const role = data.killed.role ? ` (${data.killed.role})` : '';
        print(red(`☠  ${bold(data.killed.name)} was killed tonight${role}.`));
        if (data.killed.id === myId) {
            isAlive = false;
            print(red(bold('You have been killed. You may watch but cannot act.')));
        }
    } else if (data.saved) {
        print(green('The doctor saved someone! Nobody died.'));
    } else {
        print(green('Nobody was killed tonight.'));
    }
});

socket.on('game:vote_count', (data) => {
    print(cyan(`Votes cast: ${data.votesIn} / ${data.totalVoters}`));
});

socket.on('game:vote_extension', (data) => {
    print(yellow(`Voting extended — new deadline in ${Math.round((data.newExpiresAt - Date.now()) / 1000)}s.`));
});

socket.on('game:vote_results', (data) => {
    print(yellow(bold('─── VOTE RESULTS ───')));
    if (data.eliminated) {
        const role = data.eliminated.role ? ` (${data.eliminated.role})` : '';
        print(red(`⚰  ${bold(data.eliminated.name)} was eliminated${role}.`));
        if (data.eliminated.id === myId) {
            isAlive = false;
            print(red(bold('You have been eliminated!')));
        }
    } else if (data.allAbstained) {
        print(yellow('Nobody voted — no elimination.'));
    } else {
        print(yellow('Tie — nobody eliminated.'));
    }
});

socket.on('game:over', (data) => {
    currentPhase = 'game_over';
    const paint = data.winner === 'mafia' ? red : green;
    banner(`GAME OVER — ${data.winner.toUpperCase()} WINS!`, paint);
    const winnerNames = data.leaderboard.map(id => players.find(p => p.id === id)?.name ?? id);
    print(cyan(`Rounds: ${data.rounds}  |  Winners: ${winnerNames.join(', ')}`));
    if (isHost) print(cyan('Type "again" to play again, or "quit" to exit.'));
    else print(cyan('Type "quit" to exit.'));
    prompt();
});

socket.on('player:reconnected', ({ gameState }) => {
    currentPhase = gameState.phase;
    players = gameState.players;
    const me = players.find(p => p.id === myId);
    isAlive = me?.isAlive ?? true;
    if (gameState.myRole) myRole = gameState.myRole;
    print(green('Reconnected to game.'));
    print(cyan(`Phase: ${gameState.phase}  |  Round: ${gameState.round}`));
    if (myRole) print(roleColor(myRole)(`Your role: ${myRole.toUpperCase()}`));
    prompt();
});

socket.on('disconnect', () => {
    print(red('Disconnected from server.'));
});

// ── Command handling ──────────────────────────────────────────────────────────

rl.on('line', (line) => {
    const [cmd, ...args] = line.trim().split(/\s+/);
    if (!cmd) { prompt(); return; }

    switch (cmd.toLowerCase()) {
        case 'start':
            if (isHost && currentPhase === 'lobby') socket.emit('game:start');
            else print(red('Only the host can start from the lobby.'));
            break;

        case 'cancel':
            if (isHost && currentPhase === 'countdown') socket.emit('game:cancel_start');
            else print(red('Nothing to cancel.'));
            break;

        case 'ack':
            socket.emit('game:acknowledge_role');
            print(green('Role acknowledged.'));
            break;

        case 'act': {
            const name = args.join(' ');
            if (!name) { print(red('Usage: act <playerName>')); break; }
            const canTargetSelf = myRole === 'doctor';
            const target = players.find(p =>
                p.name.toLowerCase() === name.toLowerCase() &&
                p.isAlive &&
                (canTargetSelf || p.id !== myId)
            );
            if (!target) {
                print(red(`"${name}" is not a valid target.`));
                listAlivePlayers();
            } else {
                socket.emit('game:night_action', { targetId: target.id });
            }
            break;
        }

        case 'vote': {
            if (!isAlive) { print(red('Dead players cannot vote.')); break; }
            const name = args.join(' ');
            if (!name) { print(red('Usage: vote <playerName>')); break; }
            const target = players.find(p =>
                p.name.toLowerCase() === name.toLowerCase() &&
                p.isAlive &&
                p.id !== myId
            );
            if (!target) {
                print(red(`"${name}" not found or cannot vote for them.`));
                listAlivePlayers();
            } else {
                socket.emit('game:vote', { targetId: target.id });
            }
            break;
        }

        case 'extend':
            if (isHost && currentPhase === 'discussion') socket.emit('game:extend_timer');
            else print(red('Only the host can extend during discussion.'));
            break;

        case 'again':
            if (isHost && currentPhase === 'game_over') socket.emit('game:play_again');
            else print(red('Only the host can restart after game over.'));
            break;

        case 'players': {
            const list = players.map(p =>
                `  ${p.isAlive ? green(p.name) : red(p.name + ' [dead]')}` +
                (p.isHost ? yellow(' [host]') : '') +
                (p.id === myId ? bold(' (you)') : '')
            ).join('\n');
            print(list || cyan('No players yet.'));
            break;
        }

        case 'help':
            print([
                cyan(bold('Commands:')),
                `  ${cyan('start')}        Start game  (host · lobby)`,
                `  ${cyan('cancel')}       Cancel countdown  (host)`,
                `  ${cyan('ack')}          Acknowledge role`,
                `  ${cyan('act <name>')}   Night action`,
                `  ${cyan('vote <name>')}  Vote to eliminate`,
                `  ${cyan('extend')}       Add 30s to discussion  (host)`,
                `  ${cyan('players')}      List players`,
                `  ${cyan('again')}        Play again  (host · game over)`,
                `  ${cyan('quit')}         Exit`,
            ].join('\n'));
            break;

        case 'quit':
        case 'exit':
            socket.disconnect();
            process.exit(0);
            break;

        default:
            print(red(`Unknown command "${cmd}". Type "help".`));
    }

    prompt();
});

rl.on('close', () => {
    socket.disconnect();
    process.exit(0);
});
