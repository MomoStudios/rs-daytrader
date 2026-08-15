import { describe, expect, test } from 'bun:test';
import { reservationViolations, smithingBarCost } from '../lib/reservationPolicy';
import { minimumSafeBundleAsk } from '../lib/tradeEvaluator';
import type { OperatorWorkflow } from '../lib/operatorSchema';

const workflow = (product: string, goal: string): OperatorWorkflow => ({
    name: 'smith-item',
    goal,
    reusable: true,
    version: 1,
    successCriteria: ['item made'],
    steps: [
        {
            id: 'smith',
            description: 'Smith item',
            directive: { type: 'smith_product', product, bar: 'Iron bar' },
            completion: { type: 'action_success' },
            repeatUntilComplete: false,
            maxAttempts: 3,
        },
    ],
});

const assets = {
    inventory: [{ name: 'Iron bar', count: 6 }],
    equipment: [],
    bank: [],
    inventoryObservedAt: 1,
    bankObservedAt: null,
    bankObservationSource: 'never_observed' as const,
    combinedHoldings: [{ name: 'Iron bar', count: 6 }],
};

describe('material reservation policy', () => {
    test('knows common smithing bar costs', () => {
        expect(smithingBarCost('med helm')).toBe(1);
        expect(smithingBarCost('platelegs')).toBe(3);
        expect(smithingBarCost('platebody')).toBe(5);
    });

    test('blocks unrelated smithing below a reserved floor', () => {
        expect(
            reservationViolations(
                workflow('med helm', 'Smith an iron med helm'),
                [{ item: 'Iron bar', count: 5, purpose: 'demanded iron platebody' }],
                assets
            )
        ).toHaveLength(0);
        expect(
            reservationViolations(
                workflow('platelegs', 'Smith iron platelegs'),
                [{ item: 'Iron bar', count: 5, purpose: 'demanded iron platebody' }],
                assets
            )
        ).toHaveLength(1);
    });

    test('allows consuming a reservation for its stated product', () => {
        expect(
            reservationViolations(
                workflow('iron platebody', 'Smith the demanded iron platebody'),
                [{ item: 'Iron bar', count: 5, purpose: 'demanded iron platebody' }],
                assets
            )
        ).toEqual([]);
    });

    test('raises an unsafe bundle price to the deterministic profit floor', () => {
        const ask = minimumSafeBundleAsk(
            [
                { name: 'Iron platebody', count: 1 },
                { name: 'Iron platelegs', count: 1 },
                { name: 'Iron full helm', count: 1 },
                { name: 'Iron sq shield', count: 1 },
            ],
            150
        );
        expect(ask.totalValueGp).toBe(1_162);
        expect(ask.safeAskGp).toBeGreaterThan(1_162);
        expect(ask.unknownItems).toEqual([]);
    });
});
