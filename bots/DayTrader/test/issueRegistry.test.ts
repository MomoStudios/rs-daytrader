import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _resetRegistryForTests } from '../lib/registryDb';
import {
    computeFingerprint,
    getIssue,
    getIssueByFingerprint,
    listIssues,
    listOverdueIssues,
    recordIssue,
    severityDeadlineMs,
    transitionIssue,
} from '../lib/issueRegistry';

beforeEach(() => {
    _resetRegistryForTests(':memory:');
});

afterEach(() => {
    _resetRegistryForTests(':memory:');
});

function baseInput(overrides: Partial<Parameters<typeof recordIssue>[0]> = {}) {
    return {
        fingerprint: computeFingerprint(['workflow', 'chop willow trees', 'operator']),
        ownerLayer: 'operator' as const,
        severity: 'medium' as const,
        category: 'failure' as const,
        title: 'Willow chopping workflow stalls at Draynor',
        description: 'Step never completes; no xp gained for 60s.',
        evidence: ['no xp change for 60s'],
        ...overrides,
    };
}

describe('issue registry - fingerprint dedup and reopen', () => {
    test('creates a new detected issue on first detection', () => {
        const issue = recordIssue(baseInput());
        expect(issue.status).toBe('detected');
        expect(issue.recurrenceCount).toBe(0);
        expect(issue.attempts).toBe(0);
        expect(issue.evidence).toEqual(['no xp change for 60s']);
        expect(issue.deadlineAt).toBeGreaterThan(Date.now());
    });

    test('dedupes repeated detections of the same fingerprint into one row', () => {
        const first = recordIssue(baseInput());
        const second = recordIssue(baseInput({ evidence: ['still stalled after 90s'] }));
        expect(second.id).toBe(first.id);
        expect(second.evidence).toEqual(['no xp change for 60s', 'still stalled after 90s']);
        expect(listIssues().length).toBe(1);
    });

    test('does not increment recurrenceCount while an issue is still open', () => {
        recordIssue(baseInput());
        const again = recordIssue(baseInput());
        expect(again.recurrenceCount).toBe(0);
        expect(again.status).toBe('detected');
    });

    test('reopens a resolved issue that recurs and increments recurrenceCount', () => {
        const created = recordIssue(baseInput());
        transitionIssue({ id: created.id, status: 'resolved', resolutionEvidence: 'workflow repaired' });
        const resolved = getIssue(created.id)!;
        expect(resolved.status).toBe('resolved');
        expect(resolved.resolvedAt).not.toBeNull();

        const reopened = recordIssue(baseInput({ evidence: ['stalled again after repair'] }));
        expect(reopened.id).toBe(created.id);
        expect(reopened.status).toBe('detected');
        expect(reopened.recurrenceCount).toBe(1);
        expect(reopened.resolvedAt).toBeNull();
        expect(reopened.resolutionEvidence).toBeNull();
    });

    test('reopens a rejected or deferred issue on recurrence too', () => {
        const created = recordIssue(baseInput());
        transitionIssue({ id: created.id, status: 'deferred', note: 'owned by human, no action yet' });
        const reopened = recordIssue(baseInput());
        expect(reopened.status).toBe('detected');
        expect(reopened.recurrenceCount).toBe(1);
    });

    test('different fingerprints never collide', () => {
        const a = recordIssue(baseInput());
        const b = recordIssue(
            baseInput({ fingerprint: computeFingerprint(['workflow', 'mine iron ore', 'operator']) })
        );
        expect(a.id).not.toBe(b.id);
        expect(listIssues().length).toBe(2);
    });
});

describe('issue registry - lifecycle transitions', () => {
    test('walks through the full lifecycle with history', () => {
        const created = recordIssue(baseInput());
        const triaged = transitionIssue({ id: created.id, status: 'triaged' });
        expect(triaged.status).toBe('triaged');
        const repairing = transitionIssue({ id: created.id, status: 'repairing', incrementAttempts: true });
        expect(repairing.attempts).toBe(1);
        const validating = transitionIssue({ id: created.id, status: 'validating' });
        expect(validating.status).toBe('validating');
        const canary = transitionIssue({ id: created.id, status: 'canary' });
        expect(canary.status).toBe('canary');
        const resolved = transitionIssue({
            id: created.id,
            status: 'resolved',
            resolutionEvidence: 'canary succeeded twice',
        });
        expect(resolved.status).toBe('resolved');
        expect(resolved.resolutionEvidence).toBe('canary succeeded twice');
        expect(resolved.resolvedAt).not.toBeNull();
    });

    test('throws (does not silently no-op) when transitioning an unknown issue id', () => {
        expect(() => transitionIssue({ id: 'issue-does-not-exist', status: 'resolved' })).toThrow();
    });

    test('links a related workflow id on transition', () => {
        const created = recordIssue(baseInput());
        const linked = transitionIssue({
            id: created.id,
            status: 'repairing',
            relatedWorkflowId: 'candidate-123',
        });
        expect(linked.relatedWorkflowId).toBe('candidate-123');
    });
});

describe('issue registry - queries and metrics inputs', () => {
    test('filters by status/ownerLayer/category', () => {
        recordIssue(baseInput());
        recordIssue(
            baseInput({
                fingerprint: computeFingerprint(['escalation', 'competition', 'strategist']),
                ownerLayer: 'strategist',
                category: 'escalation',
            })
        );
        expect(listIssues({ ownerLayer: 'strategist' }).length).toBe(1);
        expect(listIssues({ category: 'escalation' }).length).toBe(1);
        expect(listIssues({ status: 'detected' }).length).toBe(2);
        expect(listIssues({ openOnly: true }).length).toBe(2);
    });

    test('finds overdue issues past their deadline', () => {
        const created = recordIssue(baseInput({ deadlineAt: Date.now() - 1000 }));
        const overdue = listOverdueIssues();
        expect(overdue.map(issue => issue.id)).toContain(created.id);
    });

    test('resolved issues are excluded from overdue results', () => {
        const created = recordIssue(baseInput({ deadlineAt: Date.now() - 1000 }));
        transitionIssue({ id: created.id, status: 'resolved' });
        expect(listOverdueIssues().map(issue => issue.id)).not.toContain(created.id);
    });

    test('getIssueByFingerprint finds the same row recordIssue returns', () => {
        const created = recordIssue(baseInput());
        const found = getIssueByFingerprint(created.fingerprint);
        expect(found?.id).toBe(created.id);
    });

    test('severityDeadlineMs orders critical before low', () => {
        const now = Date.now();
        expect(severityDeadlineMs('critical', now)).toBeLessThan(severityDeadlineMs('low', now));
        expect(severityDeadlineMs('high', now)).toBeLessThan(severityDeadlineMs('medium', now));
    });
});
