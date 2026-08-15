import { describe, expect, test } from 'bun:test';
import { shouldRequestAiPlan } from '../lib/planningPolicy';

describe('AI planning policy', () => {
    test('keeps deferred chat pending after the cooldown window', () => {
        expect(
            shouldRequestAiPlan({
                pendingChatForAi: true,
                hasActiveAction: true,
                now: 31_000,
                lastPlannedAt: 10_000,
                planIntervalMs: 120_000,
            })
        ).toBe(true);
    });

    test('does not replan a healthy action without chat before the interval', () => {
        expect(
            shouldRequestAiPlan({
                pendingChatForAi: false,
                hasActiveAction: true,
                now: 31_000,
                lastPlannedAt: 10_000,
                planIntervalMs: 120_000,
            })
        ).toBe(false);
    });
});
