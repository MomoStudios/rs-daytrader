// WordPack frame safety: chat frames carry a 1-byte length, so packed output
// must never exceed ~240 bytes no matter what text goes in - digits and
// punctuation pack at 2 nibbles per char (vs 1 for common letters), so a long
// message can hit 1 byte per char. Without the budget clamp the length byte
// wraps at 256 and corrupts the protocol stream.

import { describe, test, expect } from 'bun:test';
import Packet from '#/io/Packet.js';
import WordPack from '#/wordfilter/WordPack.js';

function packToBytes(text: string): number {
    const buf = new Packet(new Uint8Array(1024));
    WordPack.pack(buf, text);
    return buf.pos;
}

function roundtrip(text: string): string {
    const buf = new Packet(new Uint8Array(1024));
    WordPack.pack(buf, text);
    const length = buf.pos;
    buf.pos = 0;
    return WordPack.unpack(buf, length);
}

describe('WordPack packed-byte budget', () => {
    test('a 400-char sentence of common chars packs under budget and survives roundtrip', () => {
        const text = 'the rain in the north hits the shore and then it eases and then it starts '.repeat(6).trim().slice(0, 400);
        expect(packToBytes(text)).toBeLessThanOrEqual(240);
        expect(roundtrip(text).toLowerCase()).toBe(text.toLowerCase());
    });

    test('400 digits are clamped to the byte budget instead of overflowing the frame', () => {
        const bytes = packToBytes('9'.repeat(400));
        expect(bytes).toBeLessThanOrEqual(240);
    });

    test('clamped digit text decodes to an intact prefix', () => {
        const decoded = roundtrip('1234567890'.repeat(40));
        expect(decoded.length).toBeGreaterThan(0);
        expect('1234567890'.repeat(40).startsWith(decoded)).toBe(true);
    });

    test('unpack handles messages longer than the old 100-char clamp', () => {
        const text = 'a'.repeat(300);
        expect(roundtrip(text).toLowerCase()).toBe(text.toLowerCase());
    });
});
