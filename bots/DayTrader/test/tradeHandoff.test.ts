import { describe, expect, test } from 'bun:test';
import { compileTradeHandoff } from '../lib/tradeHandoff';
import type { AiDecision } from '../lib/aiDecision';

const decision: AiDecision = {
    summary: 'Fulfill held armor order.',
    marketSignals: [],
    reservations: [],
    tradeOrders: [
        {
            kind: 'sell_bundle',
            recipient: 'Henryatkins',
            items: [
                { item: 'Iron platebody', amount: 1 },
                { item: 'Iron platelegs', amount: 1 },
            ],
            priceGp: 150,
            rationale: 'Confirmed demand.',
        },
    ],
    goal: {
        kind: 'item_acquisition',
        target: 'Next portfolio item',
        targetValue: 1,
        rationale: 'After trade.',
    },
    chatActions: [],
    nextAction: { type: 'wait' },
};

describe('deterministic trade handoff compiler', () => {
    test('stages banked items before atomic trade', () => {
        const compiled = compileTradeHandoff(decision, {
            inventory: [{ name: 'Iron platebody', count: 1 }],
            equipment: [],
            bank: [{ name: 'Iron platelegs', count: 1 }],
            inventoryObservedAt: 1,
            bankObservedAt: 1,
            bankObservationSource: 'live_open_bank',
            combinedHoldings: [
                { name: 'Iron platebody', count: 1 },
                { name: 'Iron platelegs', count: 1 },
            ],
        });
        expect(compiled?.workflow?.steps.map(step => step.directive.type)).toEqual([
            'bank_open',
            'bank_withdraw',
            'bank_close',
            'trade_bundle_sell',
        ]);
    });

    test('trades immediately when the full bundle is carried', () => {
        const compiled = compileTradeHandoff(decision, {
            inventory: [
                { name: 'Iron platebody', count: 1 },
                { name: 'Iron platelegs', count: 1 },
            ],
            equipment: [],
            bank: [],
            inventoryObservedAt: 1,
            bankObservedAt: null,
            bankObservationSource: 'never_observed',
            combinedHoldings: [
                { name: 'Iron platebody', count: 1 },
                { name: 'Iron platelegs', count: 1 },
            ],
        });
        expect(compiled?.workflow?.steps.map(step => step.directive.type)).toEqual([
            'trade_bundle_sell',
        ]);
    });

    test('declines compilation when items are not held account-wide', () => {
        expect(
            compileTradeHandoff(decision, {
                inventory: [],
                equipment: [],
                bank: [],
                inventoryObservedAt: 1,
                bankObservedAt: null,
                bankObservationSource: 'never_observed',
                combinedHoldings: [],
            })
        ).toBeNull();
    });
});
