import { describe, expect, test } from 'bun:test';
import { computeAutonomousBackoffMs, computeNextRetryAt } from '../maintenance/autonomousRetryPolicy';

describe('autonomous retry/backoff policy', () => {
    test('grows exponentially with attempts', () => {
        const a1 = computeAutonomousBackoffMs(1);
        const a2 = computeAutonomousBackoffMs(2);
        const a3 = computeAutonomousBackoffMs(3);
        expect(a2).toBe(a1 * 2);
        expect(a3).toBe(a1 * 4);
    });

    test('is bounded by a maximum backoff regardless of how many attempts accumulate', () => {
        const huge = computeAutonomousBackoffMs(1000);
        expect(huge).toBeLessThanOrEqual(6 * 60 * 60_000);
        expect(huge).toBe(computeAutonomousBackoffMs(50)); // both saturate at the cap
    });

    test('never returns zero or negative for zero/negative attempts (treated as attempt 1)', () => {
        expect(computeAutonomousBackoffMs(0)).toBeGreaterThan(0);
        expect(computeAutonomousBackoffMs(-5)).toBeGreaterThan(0);
    });

    test('computeNextRetryAt adds the backoff to the provided "now"', () => {
        const now = 1_000_000;
        expect(computeNextRetryAt(1, now)).toBe(now + computeAutonomousBackoffMs(1));
    });
});
