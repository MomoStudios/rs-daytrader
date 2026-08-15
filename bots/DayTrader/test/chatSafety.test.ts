import { describe, expect, test } from 'bun:test';
import { normalizeOutgoingMessage, validateConversationalReply } from '../lib/chatSafety';
import { assessMessage } from '../lib/scamGuard';
import { ESSENTIAL_TOOL_PATTERN } from '../lib/tradeEvaluator';

describe('AI chat output boundary', () => {
    test('allows ordinary non-transactional conversation', () => {
        expect(validateConversationalReply('Are you after melee armor or ranged gear?')).toBe(
            'Are you after melee armor or ranged gear?'
        );
    });

    test('rejects deposits and future-delivery commitments in replies', () => {
        expect(() => validateConversationalReply('Pay a deposit and I will bring the armor later.')).toThrow();
        expect(() => validateConversationalReply("I'll meet you with the full set.")).toThrow('transaction');
    });

    test('requires typed offers for prices and sales', () => {
        expect(() => validateConversationalReply('I can sell logs for 6 gp.')).toThrow('transaction');
    });

    test('allows general discussion of goals and market activity', () => {
        expect(validateConversationalReply('Turning logs into gp so I can work toward better gear.')).toBe(
            'Turning logs into gp so I can work toward better gear.'
        );
    });

    test('treats deposit requests as high-risk incoming chat', () => {
        expect(assessMessage('Pay a deposit upfront before I bring it').highRisk).toBe(true);
    });

    test('still permits safe open-ended broadcasts through basic normalization', () => {
        expect(normalizeOutgoingMessage('What armor are people looking for?')).toBe(
            'What armor are people looking for?'
        );
    });

    test('keeps progression tools out of AI-directed sales', () => {
        expect(ESSENTIAL_TOOL_PATTERN.test('Bronze axe')).toBe(true);
        expect(ESSENTIAL_TOOL_PATTERN.test('Bronze pickaxe')).toBe(true);
        expect(ESSENTIAL_TOOL_PATTERN.test('Small fishing net')).toBe(true);
    });
});
