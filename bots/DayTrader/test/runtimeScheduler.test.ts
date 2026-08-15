import { describe, expect, test } from 'bun:test';
import {
    enqueueUniqueName,
    preparedPlanIsStale,
} from '../lib/runtimeScheduler';

describe('concurrent runtime scheduler', () => {
    test('queues unique trade requesters without losing distinct names', () => {
        const queue: string[] = [];
        expect(enqueueUniqueName(queue, 'Alice')).toBe(true);
        expect(enqueueUniqueName(queue, 'alice')).toBe(false);
        expect(enqueueUniqueName(queue, 'Bob')).toBe(true);
        expect(queue).toEqual(['Alice', 'Bob']);
    });

    test('discards a plan when chat changes during inference', () => {
        expect(
            preparedPlanIsStale({
                planChatGeneration: 4,
                currentChatGeneration: 5,
                planGuidanceIds: [],
                pendingGuidanceIds: [],
            })
        ).toBe(true);
    });

    test('discards a plan when new human guidance arrives', () => {
        expect(
            preparedPlanIsStale({
                planChatGeneration: 5,
                currentChatGeneration: 5,
                planGuidanceIds: ['old'],
                pendingGuidanceIds: ['old', 'new'],
            })
        ).toBe(true);
    });

    test('accepts a plan generated from current inputs', () => {
        expect(
            preparedPlanIsStale({
                planChatGeneration: 5,
                currentChatGeneration: 5,
                planGuidanceIds: ['current'],
                pendingGuidanceIds: ['current'],
            })
        ).toBe(false);
    });
});
