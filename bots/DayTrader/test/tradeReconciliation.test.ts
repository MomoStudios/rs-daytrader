import { describe, expect, test } from 'bun:test';
import {
    inventoryDelta,
    summarizeInventory,
} from '../lib/tradeReconciliation';

describe('trade outcome reconciliation', () => {
    test('derives gave and received items from inventory changes', () => {
        const before = summarizeInventory([
            { id: 1, name: 'Iron dagger', count: 1 },
            { id: 995, name: 'Coins', count: 10 },
        ]);
        const after = summarizeInventory([
            { id: 995, name: 'Coins', count: 25 },
        ]);
        expect(inventoryDelta(before, after)).toEqual({
            gave: [{ slot: -1, id: 1, name: 'Iron dagger', count: 1 }],
            received: [{ slot: -1, id: 995, name: 'Coins', count: 15 }],
        });
    });

    test('reports no exchange when the session closes without inventory change', () => {
        const before = summarizeInventory([
            { id: 995, name: 'Coins', count: 10 },
        ]);
        const after = summarizeInventory([
            { id: 995, name: 'Coins', count: 10 },
        ]);
        expect(inventoryDelta(before, after)).toEqual({ gave: [], received: [] });
    });
});
