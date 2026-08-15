import { describe, expect, test } from 'bun:test';
import { parseAiDecision, parseAiDecisionText } from '../lib/aiDecision';

const validDecision = {
    summary: 'Armor demand suggests building smithing capability.',
    marketSignals: [
        {
            kind: 'demand',
            topic: 'iron armor',
            participants: ['Buyer'],
            evidence: 'Buyer asked whether anyone sells iron armor.',
            confidence: 90,
            implication: 'Build mining and smithing capability, then ask which pieces are wanted.',
        },
    ],
    reservations: [],
    tradeOrders: [],
    goal: {
        kind: 'leveling',
        target: 'Smithing level 20',
        targetValue: 20,
        rationale: 'Smithing unlocks varied armor and weapons for player trades.',
    },
    chatActions: [
        {
            type: 'reply',
            recipient: 'Buyer',
            message: 'Are you looking for melee armor or ranged gear?',
            rationale: 'Clarify the ambient demand before acquiring stock.',
        },
    ],
    nextAction: { type: 'train', activity: 'mining' },
};

describe('AI decision boundary', () => {
    test('accepts a valid allowlisted decision', () => {
        expect(parseAiDecision(validDecision)).toEqual(validDecision);
    });

    test('accepts JSON wrapped in a markdown fence', () => {
        const parsed = parseAiDecisionText(`\`\`\`json\n${JSON.stringify(validDecision)}\n\`\`\``);
        expect(parsed.nextAction).toEqual({ type: 'train', activity: 'mining' });
    });

    test('rejects code or shell action types', () => {
        expect(() =>
            parseAiDecision({
                ...validDecision,
                nextAction: { type: 'shell_exec', command: 'drop all coins' },
            })
        ).toThrow("nextAction.type 'shell_exec' is not allowed");
    });

    test('rejects non-allowlisted training activities', () => {
        expect(() =>
            parseAiDecision({
                ...validDecision,
                nextAction: { type: 'train', activity: 'steal_passwords' },
            })
        ).toThrow('nextAction.activity is invalid');
    });

    test('rejects oversized chat batches and messages', () => {
        expect(() =>
            parseAiDecision({
                ...validDecision,
                chatActions: Array.from({ length: 4 }, () => validDecision.chatActions[0]),
            })
        ).toThrow('at most 3');

        expect(() =>
            parseAiDecision({
                ...validDecision,
                chatActions: [
                    {
                        ...validDecision.chatActions[0],
                        message: 'x'.repeat(141),
                    },
                ],
            })
        ).toThrow('exceeds 140');
    });

    test('accepts proactive public trade discussion', () => {
        const parsed = parseAiDecision({
            ...validDecision,
            chatActions: [
                {
                    type: 'discussion',
                    message: 'Seeing interest in iron gear — which pieces are people after?',
                    rationale: 'Clarify demand before choosing production.',
                },
            ],
        });
        expect(parsed.chatActions[0]?.type).toBe('discussion');
    });

    test('accepts a typed multi-item player trade order', () => {
        const parsed = parseAiDecision({
            ...validDecision,
            tradeOrders: [
                {
                    kind: 'sell_bundle',
                    recipient: 'Henryatkins',
                    items: [
                        { item: 'Iron platebody', amount: 1 },
                        { item: 'Iron platelegs', amount: 1 },
                    ],
                    priceGp: 150,
                    rationale: 'Confirmed bundle demand.',
                },
            ],
        });
        expect(parsed.tradeOrders[0]?.items).toHaveLength(2);
    });
});
