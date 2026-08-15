import { describe, expect, test } from 'bun:test';
import { DESTINATIONS } from '../lib/aiDecision';
import { DESTINATION_LIBRARY } from '../lib/skillLibrary';

describe('progression skill library', () => {
    test('maps every model-visible destination to fixed coordinates', () => {
        for (const destination of DESTINATIONS) {
            const definition = DESTINATION_LIBRARY[destination];
            expect(Number.isFinite(definition.x)).toBe(true);
            expect(Number.isFinite(definition.z)).toBe(true);
            expect(definition.description.length).toBeGreaterThan(0);
        }
    });
});
