import { describe, expect, test } from 'bun:test';
import { COLLECTION_TARGETS, updateCollectionStatus } from '../lib/collectionPortfolio';

describe('background collection portfolio', () => {
    test('contains unique targets with acquisition knowledge', () => {
        const names = COLLECTION_TARGETS.map(target => target.item.toLowerCase());
        expect(new Set(names).size).toBe(names.length);
        expect(COLLECTION_TARGETS.filter(target => target.category === 'craftable_armor').length).toBe(16);
        for (const target of COLLECTION_TARGETS) {
            expect(target.acquisition.method.length).toBeGreaterThan(10);
            expect(target.acquisition.location.length).toBeGreaterThan(2);
        }
    });

    test('reports held stock and missing acquisition guides', () => {
        const status = updateCollectionStatus([
            { name: 'Tin ore', count: 10 },
            { name: 'Bronze bar', count: 3 },
        ]);
        expect(status.targetsCurrentlyStocked).toBeGreaterThanOrEqual(1);
        expect(status.priorityMissing.some(target => target.item === 'Iron ore')).toBe(true);
        expect(
            status.priorityMissing.find(target => target.item === 'Iron ore')?.acquisition.automatedActions
        ).toContain('train:mining');
    });
});
