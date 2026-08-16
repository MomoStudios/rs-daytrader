import { describe, expect, test } from 'bun:test';
import { computeRestartDelayMs, isFastFailure } from '../run-supervisor';
import { isHeartbeatStale } from '../lib/runtimeHealth';

const spec = {
    name: 'test-child',
    cmd: ['true'],
    cwd: '.',
    baseRestartDelayMs: 5_000,
    maxRestartDelayMs: 60_000,
    fastFailureThresholdMs: 10_000,
};

describe('supervisor - fast failure detection', () => {
    test('a run shorter than the threshold counts as a fast failure', () => {
        expect(isFastFailure(500, 10_000)).toBe(true);
    });

    test('a long-lived run does not count as a fast failure', () => {
        expect(isFastFailure(60_000, 10_000)).toBe(false);
    });
});

describe('supervisor - restart backoff', () => {
    test('the first failure restarts after the base delay', () => {
        expect(computeRestartDelayMs(spec, 1)).toBe(5_000);
    });

    describe('supervisor - heartbeat liveness', () => {
        test('marks missing and old heartbeats stale', () => {
            expect(isHeartbeatStale(null, 10_000, 1_000)).toBe(true);
            expect(isHeartbeatStale(8_000, 10_000, 1_000)).toBe(true);
        });

        test('keeps a recent heartbeat healthy', () => {
            expect(isHeartbeatStale(9_500, 10_000, 1_000)).toBe(false);
        });
    });

    test('backoff doubles with each consecutive fast failure', () => {
        expect(computeRestartDelayMs(spec, 2)).toBe(10_000);
        expect(computeRestartDelayMs(spec, 3)).toBe(20_000);
        expect(computeRestartDelayMs(spec, 4)).toBe(40_000);
    });

    test('backoff is capped at maxRestartDelayMs', () => {
        expect(computeRestartDelayMs(spec, 10)).toBe(60_000);
    });

    test('zero consecutive failures still yields the base delay (never zero/negative)', () => {
        expect(computeRestartDelayMs(spec, 0)).toBe(5_000);
    });
});
