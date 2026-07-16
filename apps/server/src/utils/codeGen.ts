import { customAlphabet } from 'nanoid';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@mafia/shared';

const generate = customAlphabet(ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH);

export function generateRoomCode(existingCodes: Set<string>): string {
    let code: string;
    do {
        code = generate();
    } while (existingCodes.has(code));
    return code;
}
