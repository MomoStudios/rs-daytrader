import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _resetRegistryForTests } from '../lib/registryDb';
import {
    claimMaintenanceWork,
    getMaintenanceWork,
    listMaintenanceWork,
    proposeMaintenanceWork,
    transitionMaintenanceWork,
} from '../lib/maintenanceStore';

beforeEach(() => {
    _resetRegistryForTests(':memory:');
});

afterEach(() => {
    _resetRegistryForTests(':memory:');
});

describe('maintenance store - proposal and reuse', () => {
    test('proposes a new maintenance work item in status proposed', () => {
        const work = proposeMaintenanceWork('issue-1', 'regenerate-api-docs');
        expect(work.status).toBe('proposed');
        expect(work.issueId).toBe('issue-1');
        expect(work.recipeId).toBe('regenerate-api-docs');
        expect(work.attempts).toBe(0);
    });

    test('proposing the same issue+recipe again while open reuses the same row', () => {
        const first = proposeMaintenanceWork('issue-1', 'regenerate-api-docs');
        const second = proposeMaintenanceWork('issue-1', 'regenerate-api-docs');
        expect(second.id).toBe(first.id);
        expect(listMaintenanceWork().length).toBe(1);
    });

    test('allows only one worker to claim a proposed work item', () => {
        const work = proposeMaintenanceWork('issue-claim', 'regenerate-api-docs');
        expect(claimMaintenanceWork(work.id)?.status).toBe('queued');
        expect(claimMaintenanceWork(work.id)).toBeNull();
        expect(proposeMaintenanceWork('issue-claim', 'regenerate-api-docs').status).toBe('queued');
    });

    test('proposing again after a terminal outcome creates a fresh attempt', () => {
        const first = proposeMaintenanceWork('issue-1', 'regenerate-api-docs');
        transitionMaintenanceWork({ id: first.id, status: 'failed', rollbackReason: 'tests failed' });
        const second = proposeMaintenanceWork('issue-1', 'regenerate-api-docs');
        expect(second.id).not.toBe(first.id);
        expect(listMaintenanceWork({ issueId: 'issue-1' }).length).toBe(2);
    });
});

describe('maintenance store - lifecycle transitions', () => {
    test('walks through the full lifecycle to promoted', () => {
        const work = proposeMaintenanceWork('issue-2', 'regenerate-api-docs');
        transitionMaintenanceWork({ id: work.id, status: 'queued' });
        transitionMaintenanceWork({ id: work.id, status: 'running', worktreePath: '/repo/.worktrees/x', branchName: 'maintenance/x' });
        transitionMaintenanceWork({ id: work.id, status: 'tested', testOutput: 'ok' });
        const canary = transitionMaintenanceWork({ id: work.id, status: 'canary', commitSha: 'abc123', patchManifest: '1 file changed' });
        expect(canary.status).toBe('canary');
        expect(canary.commitSha).toBe('abc123');
        const promoted = transitionMaintenanceWork({ id: work.id, status: 'promoted' });
        expect(promoted.status).toBe('promoted');
        expect(promoted.completedAt).not.toBeNull();
    });

    test('rolling back records a reason and marks completion', () => {
        const work = proposeMaintenanceWork('issue-3', 'regenerate-api-docs');
        const rolledBack = transitionMaintenanceWork({
            id: work.id,
            status: 'rolled_back',
            rollbackReason: 'mandatory tests failed',
        });
        expect(rolledBack.status).toBe('rolled_back');
        expect(rolledBack.rollbackReason).toBe('mandatory tests failed');
        expect(rolledBack.completedAt).not.toBeNull();
    });

    test('throws when transitioning an unknown work item', () => {
        expect(() => transitionMaintenanceWork({ id: 'maint-missing', status: 'failed' })).toThrow();
    });

    test('getMaintenanceWork and listMaintenanceWork filter correctly', () => {
        const a = proposeMaintenanceWork('issue-a', 'regenerate-api-docs');
        transitionMaintenanceWork({ id: a.id, status: 'canary' });
        proposeMaintenanceWork('issue-b', 'regenerate-api-docs');
        expect(getMaintenanceWork(a.id)?.id).toBe(a.id);
        expect(listMaintenanceWork({ status: 'canary' }).length).toBe(1);
        expect(listMaintenanceWork({ status: 'proposed' }).length).toBe(1);
    });
});
