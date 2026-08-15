import { describe, expect, test } from 'bun:test';
import {
    evaluateGoalCompletion,
    guidanceIdsSatisfiedByGoal,
} from '../lib/goalCompletion';
import type { AssetMemory } from '../lib/assetMemory';

const assets: AssetMemory = {
    inventory: [{ name: 'Bronze bar', count: 10 }],
    equipment: [],
    bank: [{ name: 'Tin ore', count: 19 }],
    inventoryObservedAt: 1,
    bankObservedAt: 1,
    bankObservationSource: 'live_open_bank',
    combinedHoldings: [
        { name: 'Bronze bar', count: 10 },
        { name: 'Tin ore', count: 19 },
        { name: 'Coins', count: 50 },
    ],
};

describe('deterministic goal completion', () => {
    test('recognizes an item target from account-wide holdings', () => {
        const completion = evaluateGoalCompletion(
            {
                kind: 'item_acquisition',
                target: 'Acquire 10 bronze bars for Smithing',
                targetValue: 10,
                rationale: 'training',
            },
            assets,
            []
        );
        expect(completion.complete).toBe(true);
        expect(completion.actualValue).toBe(10);
    });

    test('recognizes a banked ingredient as still owned', () => {
        expect(
            evaluateGoalCompletion(
                {
                    kind: 'item_acquisition',
                    target: 'Acquire 10 tin ore',
                    targetValue: 10,
                    rationale: 'bronze',
                },
                assets,
                []
            ).complete
        ).toBe(true);
    });

    test('recognizes completed skill and wealth targets', () => {
        const skills = [
            { name: 'Smithing', level: 42, baseLevel: 42, experience: 19_477 },
        ];
        expect(
            evaluateGoalCompletion(
                {
                    kind: 'leveling',
                    target: 'Raise Smithing to level 33',
                    targetValue: 33,
                    rationale: 'platebody',
                },
                assets,
                skills
            ).complete
        ).toBe(true);
        expect(
            evaluateGoalCompletion(
                {
                    kind: 'wealth',
                    target: 'Hold 50 coins',
                    targetValue: 50,
                    rationale: 'capital',
                },
                assets,
                skills
            ).complete
        ).toBe(true);
    });

    test('resolves matching active guidance after completion', () => {
        expect(
            guidanceIdsSatisfiedByGoal(
                [
                    { id: 'bronze', text: 'smelt the bronze' },
                    { id: 'combat', text: 'train combat on goblins' },
                ],
                {
                    kind: 'item_acquisition',
                    target: 'Acquire 10 bronze bars',
                    targetValue: 10,
                    rationale: 'smithing',
                }
            )
        ).toEqual(['bronze']);
    });
});
