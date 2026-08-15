import Packet from '#/io/Packet.js';
import Environment from '#/util/Environment.js';

export default class WordPack {
    // prettier-ignore
    private static readonly CHAR_LOOKUP: string[] = [
        ' ',
        'e', 't', 'a', 'o', 'i', 'h', 'n', 's', 'r', 'd', 'l', 'u', 'm',
        'w', 'c', 'y', 'f', 'g', 'p', 'b', 'v', 'k', 'x', 'j', 'q', 'z',
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
        ' ', '!', '?', '.', ',', ':', ';', '(', ')', '-',
        '&', '*', '\\', '\'', '@', '#', '+', '=', '£', '$', '%', '"', '[', ']'
    ];

    static unpack(packet: Packet, length: number): string {
        const charBuffer: string[] = [];
        let pos: number = 0;
        let carry: number = -1;
        let nibble: number;
        // The char cap here is the real length enforcement: MessagePublicHandler's
        // byte-length check is on packed bytes (~2 chars each), so it alone would
        // let ~2x the configured chars through.
        const maxChars: number = Environment.node.maxMessageLength;
        for (let i: number = 0; i < length && pos < maxChars; i++) {
            const data: number = packet.g1();
            nibble = (data >> 4) & 0xf;
            if (carry !== -1) {
                charBuffer[pos++] = this.CHAR_LOOKUP[(carry << 4) + nibble - 195];
                carry = -1;
            } else if (nibble < 13) {
                charBuffer[pos++] = this.CHAR_LOOKUP[nibble];
            } else {
                carry = nibble;
            }
            nibble = data & 0xf;
            if (carry != -1) {
                charBuffer[pos++] = this.CHAR_LOOKUP[(carry << 4) + nibble - 195];
                carry = -1;
            } else if (nibble < 13) {
                charBuffer[pos++] = this.CHAR_LOOKUP[nibble];
            } else {
                carry = nibble;
            }
        }
        return this.toSentenceCase(charBuffer.slice(0, pos).join(''));
    }

    /**
     * Frame-safety clamp. Every chat frame (MESSAGE_PUBLIC/PRIVATE, player-info
     * chat block) carries a 1-byte length, so the packed text plus headers (up
     * to 13 bytes for PMs) must stay under 256 bytes. Common chars pack to 1
     * nibble but digits/punctuation take 2, so text heavy in those approaches
     * 1 byte per char and a char cap alone (maxMessageLength can be 400+)
     * cannot guarantee fit - without this, the length byte would wrap and
     * corrupt the stream.
     */
    private static readonly MAX_PACKED_BYTES = 240;

    private static truncateToByteBudget(input: string): string {
        let nibbles: number = 0;
        for (let i: number = 0; i < input.length; i++) {
            let index: number = this.CHAR_LOOKUP.indexOf(input.charAt(i));
            if (index < 0) index = 0; // pack() maps unknown chars to ' ' (1 nibble)
            nibbles += index > 12 ? 2 : 1;
            if (nibbles > this.MAX_PACKED_BYTES * 2) {
                return input.substring(0, i);
            }
        }
        return input;
    }

    static pack(packet: Packet, input: string): void {
        if (input.length > Environment.node.maxMessageLength) {
            input = input.substring(0, Environment.node.maxMessageLength);
        }
        input = input.toLowerCase();
        input = this.truncateToByteBudget(input);
        let carry: number = -1;
        for (let i: number = 0; i < input.length; i++) {
            const char: string = input.charAt(i);
            let index: number = 0;
            for (let j: number = 0; j < this.CHAR_LOOKUP.length; j++) {
                if (char === this.CHAR_LOOKUP[j]) {
                    index = j;
                    break;
                }
            }
            if (index > 12) {
                index += 195;
            }
            if (carry == -1) {
                if (index < 13) {
                    carry = index;
                } else {
                    packet.p1(index);
                }
            } else if (index < 13) {
                packet.p1((carry << 4) + index);
                carry = -1;
            } else {
                packet.p1((carry << 4) + (index >> 4));
                carry = index & 0xf;
            }
        }
        if (carry != -1) {
            packet.p1(carry << 4);
        }
    }

    static toSentenceCase(input: string): string {
        const chars: string[] = [...input.toLowerCase()];
        let punctuation: boolean = true;
        for (let index: number = 0; index < chars.length; index++) {
            const char: string = chars[index];
            if (punctuation && char >= 'a' && char <= 'z') {
                chars[index] = char.toUpperCase();
                punctuation = false;
            }
            if (char === '.' || char === '!') {
                punctuation = true;
            }
        }
        return chars.join('');
    }
}
