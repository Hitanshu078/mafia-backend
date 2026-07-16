import type { z } from 'zod';
import type { Socket } from 'socket.io';
import type { ClientEvents, ServerEvents } from '@mafia/shared';
import { ClientEventsSchema } from '@mafia/shared';

type Sock = Socket<ClientEvents, ServerEvents>;

/**
 * Validates an inbound payload against its Zod schema. On failure, emits
 * room:error to the sender and returns null — callers should bail out.
 */
export function parsePayload<K extends keyof typeof ClientEventsSchema>(
    socket: Sock,
    event: K,
    payload: unknown,
): z.infer<(typeof ClientEventsSchema)[K]> | null {
    const schema = ClientEventsSchema[event];
    const result = schema.safeParse(payload);
    if (!result.success) {
        socket.emit('room:error', { code: 'invalid_action', message: `Malformed payload for "${event}".` });
        return null;
    }
    return result.data as z.infer<(typeof ClientEventsSchema)[K]>;
}
