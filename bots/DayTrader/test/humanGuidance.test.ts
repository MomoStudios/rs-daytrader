import { describe, expect, test } from 'bun:test';
import { normalizeHumanGuidance } from '../lib/humanGuidance';

describe('trusted human guidance', () => {
    test('normalizes a bounded instruction', () => {
        expect(normalizeHumanGuidance('  character   is stuck - fix it  ')).toBe(
            'character is stuck - fix it'
        );
    });

    test('rejects empty and oversized instructions', () => {
        expect(() => normalizeHumanGuidance('   ')).toThrow('1-1000');
        expect(() => normalizeHumanGuidance('x'.repeat(1001))).toThrow('1-1000');
    });
});
