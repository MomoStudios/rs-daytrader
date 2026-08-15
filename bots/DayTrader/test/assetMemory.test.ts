import { describe, expect, test } from 'bun:test';
import { combineHoldings } from '../lib/assetMemory';

describe('account-wide asset memory', () => {
    test('combines inventory, equipment, and remembered bank holdings', () => {
        expect(
            combineHoldings([
                [
                    { name: 'Copper ore', count: 10 },
                    { name: 'Coins', count: 5 },
                ],
                [{ name: 'Bronze sword', count: 1 }],
                [
                    { name: 'Tin ore', count: 17 },
                    { name: 'Coins', count: 20 },
                ],
            ])
        ).toEqual([
            { name: 'Bronze sword', count: 1 },
            { name: 'Coins', count: 25 },
            { name: 'Copper ore', count: 10 },
            { name: 'Tin ore', count: 17 },
        ]);
    });

    test('retains banked ingredients absent from inventory', () => {
        const holdings = combineHoldings([
            [{ name: 'Copper ore', count: 10 }],
            [],
            [{ name: 'Tin ore', count: 10 }],
        ]);
        expect(holdings.find(item => item.name === 'Tin ore')?.count).toBe(10);
    });
});
