// chunkMessage must produce chunks that fit BOTH the char cap and the wire's
// packed-byte budget. Chat frames carry a 1-byte length, and WordPack packs
// digits/punctuation at 2 nibbles vs 1 for common chars - so a 400-char wall
// of digits packs to ~400 bytes and would corrupt the frame if sent whole.

import { describe, test, expect } from 'bun:test';
import { chunkMessage } from '../index';

const WORDPACK_COMMON_CHARS = ' etaoihnsrdlu';
const MAX_PACKED_BYTES = 240;

function packedBytes(text: string): number {
    let nibbles = 0;
    for (const ch of text.toLowerCase()) {
        nibbles += WORDPACK_COMMON_CHARS.includes(ch) ? 1 : 2;
    }
    return Math.ceil(nibbles / 2);
}

describe('chunkMessage', () => {
    test('short message is a single chunk', () => {
        expect(chunkMessage('hello there', 400)).toEqual(['hello there']);
    });

    test('a 400-char English sentence fits one chunk at the 400 cap', () => {
        const text = 'the rain in the north hits the shore and then it eases '.repeat(8).trim().slice(0, 400);
        const chunks = chunkMessage(text, 400);
        expect(chunks).toHaveLength(1);
        expect(packedBytes(chunks[0]!)).toBeLessThanOrEqual(MAX_PACKED_BYTES);
    });

    test('splits on word boundaries and loses no words', () => {
        const words = Array.from({ length: 120 }, (_, i) => `word${i}`);
        const chunks = chunkMessage(words.join(' '), 80);
        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(80);
        }
        expect(chunks.join(' ').split(' ')).toEqual(words);
    });

    test('digit-heavy text is split by the packed-byte budget, not just chars', () => {
        // 400 digits pack to ~400 bytes - must be split even though 400 <= maxLen
        const digits = '9'.repeat(400);
        const chunks = chunkMessage(digits, 400);
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            expect(packedBytes(chunk)).toBeLessThanOrEqual(MAX_PACKED_BYTES);
        }
        expect(chunks.join('')).toBe(digits);
    });

    test('every chunk of mixed digit words respects the byte budget', () => {
        const text = Array.from({ length: 40 }, (_, i) => `(${2600 + i},${3400 + i})`).join(' ');
        const chunks = chunkMessage(text, 400);
        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(400);
            expect(packedBytes(chunk)).toBeLessThanOrEqual(MAX_PACKED_BYTES);
        }
        expect(chunks.join(' ').split(/\s+/)).toEqual(text.split(/\s+/));
    });

    test('classic 80-char cap behaves as before (byte budget never binds)', () => {
        const digits = '1234567890'.repeat(12);
        const chunks = chunkMessage(digits, 80);
        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(80);
        }
        expect(chunks.join('')).toBe(digits);
    });
});
