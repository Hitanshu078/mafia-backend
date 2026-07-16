import { io, type Socket } from 'socket.io-client';
import type { ClientEvents, ServerEvents } from '@mafia/shared';

export type ClientSocket = Socket<ServerEvents, ClientEvents>;

export function connect(baseUrl: string): Promise<ClientSocket> {
    const socket: ClientSocket = io(baseUrl, { transports: ['websocket'], forceNew: true });
    return new Promise((resolve, reject) => {
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', reject);
    });
}

export function once<K extends keyof ServerEvents>(socket: ClientSocket, event: K): Promise<Parameters<ServerEvents[K]>[0]> {
    return new Promise((resolve) => socket.once(event, resolve as never));
}

export function waitForPhase(socket: ClientSocket, phase: string, timeoutMs = 75000): Promise<{ phase: string; round: number; timerExpiresAt: number | null }> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off('game:phase', handler);
            reject(new Error(`Timed out waiting for phase "${phase}"`));
        }, timeoutMs);
        function handler(payload: { phase: string; round: number; timerExpiresAt: number | null }) {
            if (payload.phase === phase) {
                clearTimeout(timer);
                socket.off('game:phase', handler);
                resolve(payload);
            }
        }
        socket.on('game:phase', handler);
    });
}
