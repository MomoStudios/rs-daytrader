import { describe, expect, test } from 'bun:test';
import { assessStall, evaluateProgress, type ProgressSnapshot } from '../lib/operatorWatchdog';

const base: ProgressSnapshot = {
    at: 0,
    tick: 100,
    revision: 100,
    position: { x: 3000, z: 3000, level: 0 },
    skills: { mining: { level: 20, xp: 10_000 } },
    inventory: {},
    dialogOpen: false,
    interfaceOpen: false,
    interfaceId: -1,
    modalOpen: false,
    modalInterface: -1,
    tradeOpen: false,
    nearbyPlayerCount: 0,
};

describe('operator watchdog', () => {
    test('detects actual XP progress', () => {
        const after = {
            ...base,
            tick: 101,
            revision: 101,
            skills: { mining: { level: 20, xp: 10_035 } },
        };
        const progress = evaluateProgress(
            base,
            after,
            { type: 'skill_xp_delta', skill: 'Mining', delta: 30 },
            true
        );
        expect(progress.complete).toBe(true);
        expect(progress.evidence).toContain('mining xp +35');
    });

    test('does not treat state revision alone as meaningful progress', () => {
        const after = { ...base, tick: 101, revision: 101 };
        const progress = evaluateProgress(
            base,
            after,
            { type: 'inventory', item: 'Runite ore', count: 1 },
            true
        );
        expect(progress.progressed).toBe(false);
        expect(progress.complete).toBe(false);
    });

    test('does not repeatedly count an old position change as new progress', () => {
        const original = base;
        const priorAttempt = {
            ...base,
            position: { x: 3001, z: 3000, level: 0 },
            tick: 101,
            revision: 101,
        };
        const current = { ...priorAttempt, tick: 102, revision: 102 };
        expect(
            evaluateProgress(
                original,
                current,
                { type: 'skill_level', skill: 'Mining', level: 70 },
                true
            ).progressed
        ).toBe(true);
        expect(
            evaluateProgress(
                priorAttempt,
                current,
                { type: 'skill_level', skill: 'Mining', level: 70 },
                true
            ).progressed
        ).toBe(false);
    });

    test('distinguishes possible competition from ordinary waiting', () => {
        const stalled = assessStall({
            attempts: 5,
            lastProgressAt: 0,
            now: 60_000,
            stateAgeMs: 100,
            sameFailureCount: 0,
            snapshot: { ...base, nearbyPlayerCount: 5 },
            recentEvidence: [],
        });
        expect(stalled.reason).toBe('possible_competition');

        const waiting = assessStall({
            attempts: 1,
            lastProgressAt: 0,
            now: 10_000,
            stateAgeMs: 100,
            sameFailureCount: 0,
            snapshot: base,
            recentEvidence: [],
        });
        expect(waiting.stalled).toBe(false);
    });

    test('detects a persistent blocking interface', () => {
        const stall = assessStall({
            attempts: 3,
            lastProgressAt: 0,
            now: 25_000,
            stateAgeMs: 100,
            sameFailureCount: 0,
            snapshot: { ...base, dialogOpen: true, modalOpen: true },
            recentEvidence: [],
        });
        expect(stall.reason).toBe('blocked_ui');
    });
});
