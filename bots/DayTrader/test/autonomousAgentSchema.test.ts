import { describe, expect, test } from 'bun:test';
import {
    assessDirectionRequestCredibility,
    parseAutonomousAgentResult,
    parseAutonomousAgentResultText,
} from '../lib/autonomousAgentSchema';

describe('autonomous agent result schema', () => {
    test('parses a resolved outcome', () => {
        const result = parseAutonomousAgentResult({
            outcome: 'resolved',
            summary: 'Fixed the off-by-one in the reservation window calculation.',
            rootCause: 'severityDeadlineMs used > instead of >=.',
            testsRun: ['bun test bots/DayTrader/test/reservationPolicy.test.ts'],
            humanQuestion: null,
        });
        expect(result.outcome).toBe('resolved');
        expect(result.testsRun).toEqual(['bun test bots/DayTrader/test/reservationPolicy.test.ts']);
        expect(result.humanQuestion).toBeNull();
    });

    test('parses an already_resolved outcome with no tests required', () => {
        const result = parseAutonomousAgentResult({
            outcome: 'already_resolved',
            summary: 'The described drift no longer reproduces on current HEAD.',
            rootCause: null,
            testsRun: [],
            humanQuestion: null,
        });
        expect(result.outcome).toBe('already_resolved');
    });

    test('parses a failed outcome (bounded retry, not human ownership)', () => {
        const result = parseAutonomousAgentResult({
            outcome: 'failed',
            summary: 'Could not reproduce the failure locally within the time budget.',
            rootCause: null,
            testsRun: ['bun test bots/DayTrader/test/tradeEvaluator.test.ts'],
            humanQuestion: null,
        });
        expect(result.outcome).toBe('failed');
    });

    test('requires_direction must include a non-empty humanQuestion', () => {
        expect(() =>
            parseAutonomousAgentResult({
                outcome: 'requires_direction',
                summary: 'Cannot proceed.',
                rootCause: null,
                testsRun: [],
                humanQuestion: null,
            })
        ).toThrow('requires_direction must include a non-empty humanQuestion');
    });

    test('requires_direction with a genuine credential/authorization question parses', () => {
        const result = parseAutonomousAgentResult({
            outcome: 'requires_direction',
            summary: 'The fix requires a new external API credential.',
            rootCause: 'The price feed integration needs an authorized API key that does not exist in this environment.',
            testsRun: [],
            humanQuestion: 'Please provision an API key for the external price feed service and store it in bot.env.',
            directionKind: 'credentials',
        });
        expect(result.outcome).toBe('requires_direction');
        expect(result.humanQuestion).toContain('API key');
        expect(result.directionKind).toBe('credentials');
    });

    test('requires_direction must include a directionKind', () => {
        expect(() =>
            parseAutonomousAgentResult({
                outcome: 'requires_direction',
                summary: 'Cannot proceed.',
                rootCause: null,
                testsRun: [],
                humanQuestion: 'Please decide something.',
            })
        ).toThrow('requires_direction must include a directionKind');
    });

    test('rejects an unrecognized directionKind value', () => {
        expect(() =>
            parseAutonomousAgentResult({
                outcome: 'requires_direction',
                summary: 'Cannot proceed.',
                rootCause: null,
                testsRun: [],
                humanQuestion: 'Please decide something.',
                directionKind: 'i_dont_feel_like_it',
            })
        ).toThrow('directionKind must be one of');
    });

    test('rejects a directionKind supplied on any non-requires_direction outcome', () => {
        expect(() =>
            parseAutonomousAgentResult({
                outcome: 'failed',
                summary: 'x',
                rootCause: null,
                testsRun: [],
                humanQuestion: null,
                directionKind: 'credentials',
            })
        ).toThrow('directionKind must be null');
    });

    test('accepts every valid directionKind value', () => {
        for (const directionKind of ['credentials', 'external_authorization', 'irreversible_policy']) {
            const result = parseAutonomousAgentResult({
                outcome: 'requires_direction',
                summary: 'x',
                rootCause: null,
                testsRun: [],
                humanQuestion: 'Please decide something.',
                directionKind,
            });
            expect(result.directionKind).toBe(directionKind as never);
        }
    });

    test('rejects an invalid outcome value', () => {
        expect(() =>
            parseAutonomousAgentResult({
                outcome: 'ask_a_human_anyway',
                summary: 'x',
                rootCause: null,
                testsRun: [],
                humanQuestion: null,
            })
        ).toThrow('outcome must be one of');
    });

    test('rejects a non-object payload', () => {
        expect(() => parseAutonomousAgentResult('not an object')).toThrow();
        expect(() => parseAutonomousAgentResult(null)).toThrow();
        expect(() => parseAutonomousAgentResult([1, 2, 3])).toThrow();
    });

    test('parses fenced JSON text and extracts the JSON object from surrounding prose', () => {
        const text = [
            'Here is my result:',
            '```json',
            JSON.stringify({
                outcome: 'resolved',
                summary: 'Done.',
                rootCause: null,
                testsRun: [],
                humanQuestion: null,
            }),
            '```',
        ].join('\n');
        expect(parseAutonomousAgentResultText(text).outcome).toBe('resolved');
    });

    test('bounds testsRun and summary length', () => {
        expect(() =>
            parseAutonomousAgentResult({
                outcome: 'resolved',
                summary: 'x'.repeat(801),
                rootCause: null,
                testsRun: [],
                humanQuestion: null,
            })
        ).toThrow();
        expect(() =>
            parseAutonomousAgentResult({
                outcome: 'resolved',
                summary: 'ok',
                rootCause: null,
                testsRun: Array.from({ length: 21 }, (_, i) => `test-${i}`),
                humanQuestion: null,
            })
        ).toThrow();
    });
});

describe('assessDirectionRequestCredibility - host-side plausibility gate', () => {
    test('accepts a credentials request whose humanQuestion plausibly matches', () => {
        expect(
            assessDirectionRequestCredibility({
                outcome: 'requires_direction',
                directionKind: 'credentials',
                humanQuestion: 'Please provision an API key for the external price feed service.',
                summary: 'Missing external credential.',
            }).ok
        ).toBe(true);
    });

    test('accepts an external_authorization request whose humanQuestion plausibly matches', () => {
        expect(
            assessDirectionRequestCredibility({
                outcome: 'requires_direction',
                directionKind: 'external_authorization',
                humanQuestion: 'This requires authorization to access a third-party account we do not have permission for.',
                summary: 'x',
            }).ok
        ).toBe(true);
    });

    test('accepts an irreversible_policy request whose humanQuestion plausibly matches', () => {
        expect(
            assessDirectionRequestCredibility({
                outcome: 'requires_direction',
                directionKind: 'irreversible_policy',
                humanQuestion: 'Two mutually exclusive game-design policy choices are both defensible; which one should the bot follow?',
                summary: 'x',
            }).ok
        ).toBe(true);
    });

    test('rejects a directionKind whose humanQuestion reads like ordinary technical uncertainty', () => {
        const result = assessDirectionRequestCredibility({
            outcome: 'requires_direction',
            directionKind: 'credentials',
            humanQuestion: 'I could not figure out why the reservation window is off by one, can someone help me debug it?',
            summary: 'Just a hard bug.',
        });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('do not plausibly match');
    });

    test('rejects any outcome other than requires_direction', () => {
        expect(
            assessDirectionRequestCredibility({
                outcome: 'failed',
                directionKind: null,
                humanQuestion: null,
                summary: 'x',
            }).ok
        ).toBe(false);
    });

    test('rejects a missing directionKind', () => {
        expect(
            assessDirectionRequestCredibility({
                outcome: 'requires_direction',
                directionKind: null,
                humanQuestion: 'Please help.',
                summary: 'x',
            }).ok
        ).toBe(false);
    });

    test('rejects an empty humanQuestion', () => {
        expect(
            assessDirectionRequestCredibility({
                outcome: 'requires_direction',
                directionKind: 'credentials',
                humanQuestion: '   ',
                summary: 'x',
            }).ok
        ).toBe(false);
    });
});
