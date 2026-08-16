import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _resetRegistryForTests } from '../lib/registryDb';
import {
    computeFingerprint,
    getIssue,
    getIssueByFingerprint,
    listIssues,
    listOverdueIssues,
    listRetryReadyIssues,
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

describe('issue registry - autonomous retry/backoff scheduling', () => {
    test('transitioning to failed with nextRetryAt persists a bounded retry deadline', () => {
        const created = recordIssue(baseInput({ ownerLayer: 'development' }));
        const retryAt = Date.now() + 60_000;
        const failed = transitionIssue({ id: created.id, status: 'failed', nextRetryAt: retryAt, incrementAttempts: true });
        expect(failed.status).toBe('failed');
        expect(failed.nextRetryAt).toBe(retryAt);
        expect(failed.attempts).toBe(1);
    });

    test('transitioning away from failed clears any pending retry deadline', () => {
        const created = recordIssue(baseInput({ ownerLayer: 'development' }));
        transitionIssue({ id: created.id, status: 'failed', nextRetryAt: Date.now() + 60_000 });
        const reopened = transitionIssue({ id: created.id, status: 'detected' });
        expect(reopened.nextRetryAt).toBeNull();
    });

    test('listRetryReadyIssues only returns development-owned failed issues past their deadline', () => {
        const ready = recordIssue(baseInput({
            fingerprint: computeFingerprint(['retry-ready']),
            ownerLayer: 'development',
        }));
        transitionIssue({ id: ready.id, status: 'failed', nextRetryAt: Date.now() - 1000 });

        const notYet = recordIssue(baseInput({
            fingerprint: computeFingerprint(['retry-not-yet']),
            ownerLayer: 'development',
        }));
        transitionIssue({ id: notYet.id, status: 'failed', nextRetryAt: Date.now() + 60_000 });

        const humanOwned = recordIssue(baseInput({
            fingerprint: computeFingerprint(['retry-human-owned']),
            ownerLayer: 'human',
        }));
        transitionIssue({ id: humanOwned.id, status: 'failed', nextRetryAt: Date.now() - 1000 });

        const readyIds = listRetryReadyIssues().map(issue => issue.id);
        expect(readyIds).toContain(ready.id);
        expect(readyIds).not.toContain(notYet.id);
        expect(readyIds).not.toContain(humanOwned.id);
    });

    test('re-recording a recurring failed issue reopens it and clears the stale retry deadline', () => {
        const created = recordIssue(baseInput({ ownerLayer: 'development' }));
        transitionIssue({ id: created.id, status: 'failed', nextRetryAt: Date.now() + 60_000 });
        const reopened = recordIssue(baseInput({ fingerprint: created.fingerprint, ownerLayer: 'development' }));
        expect(reopened.status).toBe('detected');
        expect(reopened.nextRetryAt).toBeNull();
        expect(reopened.recurrenceCount).toBe(1);
    });

    test('transitionIssue can re-route ownership to human only via an explicit ownerLayer change', () => {
        const created = recordIssue(baseInput({ ownerLayer: 'development' }));
        const requiresDirection = transitionIssue({
            id: created.id,
            status: 'deferred',
            ownerLayer: 'human',
            resolutionEvidence: 'requires external service credential the autonomous agent cannot obtain',
        });
        expect(requiresDirection.ownerLayer).toBe('human');
        expect(requiresDirection.status).toBe('deferred');
    });

    test('reopening a technical issue after requires_direction restores ownership to development and clears the human deferral', () => {
        const created = recordIssue(baseInput({ ownerLayer: 'development' }));
        transitionIssue({
            id: created.id,
            status: 'deferred',
            ownerLayer: 'human',
            resolutionEvidence: 'requires an external credential',
        });
        const deferred = recordIssue(baseInput({ fingerprint: created.fingerprint, ownerLayer: 'development' }));
        // Confirm it actually reopened (not merely re-recorded a still-open row).
        expect(deferred.status).toBe('detected');
        expect(deferred.recurrenceCount).toBe(1);
        // The key fix: ownership is restored to 'development' from the new
        // detection's own ownerLayer, not left stuck on 'human' forever.
        expect(deferred.ownerLayer).toBe('development');
        expect(deferred.resolutionEvidence).toBeNull();
    });

    test('an issue still open (not terminal) never has its ownerLayer silently overwritten by a later recordIssue call', () => {
        const created = recordIssue(baseInput({ ownerLayer: 'development' }));
        transitionIssue({ id: created.id, status: 'repairing' });
        // Some other producer re-detects the same fingerprint while a human
        // has manually taken ownership mid-flight (an edge case, but
        // ownership for a still-open issue must never be silently
        // clobbered by an ordinary re-detection).
        transitionIssue({ id: created.id, status: 'repairing', ownerLayer: 'human' });
        const redetected = recordIssue(baseInput({ fingerprint: created.fingerprint, ownerLayer: 'development' }));
        expect(redetected.status).toBe('repairing'); // still open, not reopened
        expect(redetected.ownerLayer).toBe('human'); // untouched by the merge path
    });
});

describe('issue registry - evidence-occurrence tracking (lastEvidenceAt)', () => {
    test('a new issue records its evidenceAt as lastEvidenceAt', () => {
        const created = recordIssue(baseInput({ evidenceAt: 555 }));
        expect(created.lastEvidenceAt).toBe(555);
    });

    test('a new issue with no evidenceAt leaves lastEvidenceAt null rather than defaulting to processing time', () => {
        const created = recordIssue(baseInput({}));
        expect(created.lastEvidenceAt).toBeNull();
    });

    test('re-recording an open issue only advances lastEvidenceAt when the new evidenceAt is genuinely newer', () => {
        const created = recordIssue(baseInput({ evidenceAt: 1000 }));
        expect(created.lastEvidenceAt).toBe(1000);

        // Same or older evidence re-cited - must not regress or even move.
        const stale = recordIssue(baseInput({ fingerprint: created.fingerprint, evidenceAt: 500 }));
        expect(stale.lastEvidenceAt).toBe(1000);

        // Genuinely newer evidence - advances.
        const fresh = recordIssue(baseInput({ fingerprint: created.fingerprint, evidenceAt: 2000 }));
        expect(fresh.lastEvidenceAt).toBe(2000);

        // No evidenceAt supplied this time - leaves it exactly where it was.
        const unspecified = recordIssue(baseInput({ fingerprint: created.fingerprint }));
        expect(unspecified.lastEvidenceAt).toBe(2000);
    });

    test('reopening a terminal issue resets lastEvidenceAt to this detection\'s own evidenceAt (stale evidence is not carried forward)', () => {
        const created = recordIssue(baseInput({ ownerLayer: 'development', evidenceAt: 1000 }));
        transitionIssue({ id: created.id, status: 'resolved' });
        const reopened = recordIssue(baseInput({ fingerprint: created.fingerprint, ownerLayer: 'development', evidenceAt: 42 }));
        expect(reopened.status).toBe('detected');
        expect(reopened.lastEvidenceAt).toBe(42);
    });
});
