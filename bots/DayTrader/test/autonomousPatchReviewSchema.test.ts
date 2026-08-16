import { describe, expect, test } from 'bun:test';
import {
    parseAutonomousPatchReviewResult,
    parseAutonomousPatchReviewResultText,
} from '../lib/autonomousPatchReviewSchema';

describe('autonomous patch review result schema', () => {
    test('parses an approval with no findings', () => {
        const result = parseAutonomousPatchReviewResult({
            approved: true,
            summary: 'Narrowly scoped fix; no safety boundaries touched.',
            findings: [],
        });
        expect(result.approved).toBe(true);
        expect(result.findings).toEqual([]);
    });

    test('parses an approval that still lists minor findings', () => {
        const result = parseAutonomousPatchReviewResult({
            approved: true,
            summary: 'Fine overall.',
            findings: ['Minor: could add a comment, not a safety issue.'],
        });
        expect(result.approved).toBe(true);
        expect(result.findings).toHaveLength(1);
    });

    test('a rejection must include at least one finding', () => {
        expect(() =>
            parseAutonomousPatchReviewResult({
                approved: false,
                summary: 'Rejected.',
                findings: [],
            })
        ).toThrow('at least one finding');
    });

    test('parses a rejection with findings', () => {
        const result = parseAutonomousPatchReviewResult({
            approved: false,
            summary: 'Weakens the permission handler allowlist.',
            findings: ['Removed the git subcommand denylist check entirely.'],
        });
        expect(result.approved).toBe(false);
        expect(result.findings).toContain('Removed the git subcommand denylist check entirely.');
    });

    test('rejects a non-boolean approved field', () => {
        expect(() =>
            parseAutonomousPatchReviewResult({ approved: 'yes', summary: 'x', findings: [] })
        ).toThrow('approved must be a boolean');
    });

    test('rejects a non-object payload', () => {
        expect(() => parseAutonomousPatchReviewResult('nope')).toThrow();
        expect(() => parseAutonomousPatchReviewResult(null)).toThrow();
        expect(() => parseAutonomousPatchReviewResult([1, 2])).toThrow();
    });

    test('bounds summary length and findings count', () => {
        expect(() =>
            parseAutonomousPatchReviewResult({ approved: true, summary: 'x'.repeat(801), findings: [] })
        ).toThrow();
        expect(() =>
            parseAutonomousPatchReviewResult({
                approved: false,
                summary: 'x',
                findings: Array.from({ length: 21 }, (_, i) => `finding-${i}`),
            })
        ).toThrow();
    });

    test('parses fenced JSON text and extracts the JSON object from surrounding prose', () => {
        const text = [
            'Verdict:',
            '```json',
            JSON.stringify({ approved: true, summary: 'Looks good.', findings: [] }),
            '```',
        ].join('\n');
        expect(parseAutonomousPatchReviewResultText(text).approved).toBe(true);
    });
});
