import { describe, expect, test } from 'bun:test';
import { retrieveExecutionKnowledge } from '../lib/executionKnowledge';
import type { AiDecision } from '../lib/aiDecision';

describe('operator execution knowledge retrieval', () => {
    test('retrieves server-specific runite and mining knowledge', () => {
        const decision: AiDecision = {
            summary: 'Acquire runite ore.',
            marketSignals: [],
            reservations: [],
            tradeOrders: [],
            goal: {
                kind: 'item_acquisition',
                target: 'Maintain runite ore in stock',
                targetValue: 5,
                rationale: 'High-value collection stock',
            },
            chatActions: [],
            nextAction: { type: 'train', activity: 'mining' },
        };
        const knowledge = retrieveExecutionKnowledge(decision);
        expect(knowledge.map(item => item.source)).toContain('wiki/skills/mining.md');
        expect(knowledge.find(item => item.source === 'wiki/skills/mining.md')?.content).toContain(
            '| 70 | Runite |'
        );
        expect(knowledge.map(item => item.source)).toContain('learnings/mining.md');
    });
});
