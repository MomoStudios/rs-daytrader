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

describe('maintenance store - excludeRecipeId prevents deterministic-canary starvation', () => {
    test('excludeRecipeId filters at the SQL layer (before LIMIT), so a high-volume recipe never starves another recipe out of a bounded page', () => {
        // Simulate many autonomous-development canaries flooding the table -
        // more than the bounded page size the runner asks for.
        for (let i = 0; i < 25; i += 1) {
            const work = proposeMaintenanceWork(`autonomous-issue-${i}`, 'autonomous-development');
            transitionMaintenanceWork({ id: work.id, status: 'canary' });
        }
        // A single deterministic-recipe canary, created *before* the flood,
        // so it would be the oldest (and, if excludeRecipeId only applied
        // in application code after LIMIT truncated the page, the one most
        // likely to be silently starved out of a small bounded page sorted
        // by updated_at DESC).
        const deterministic = proposeMaintenanceWork('deterministic-issue', 'regenerate-api-docs');
        transitionMaintenanceWork({ id: deterministic.id, status: 'canary' });

        // A JS-side `.filter()` applied *after* a small LIMIT would see
        // zero deterministic-recipe rows here, since every one of the 20
        // most-recently-updated rows is an autonomous-development canary.
        const filteredAtSqlLayer = listMaintenanceWork({ status: 'canary', excludeRecipeId: 'autonomous-development', limit: 20 });
        expect(filteredAtSqlLayer.some(work => work.id === deterministic.id)).toBe(true);
        expect(filteredAtSqlLayer.every(work => work.recipeId !== 'autonomous-development')).toBe(true);
    });

    test('excludeRecipeId combines with other filters (status) as an AND condition', () => {
        const proposed = proposeMaintenanceWork('issue-x', 'autonomous-development');
        const canaryOther = proposeMaintenanceWork('issue-y', 'regenerate-api-docs');
        transitionMaintenanceWork({ id: canaryOther.id, status: 'canary' });
        const canaryAutonomous = proposeMaintenanceWork('issue-z', 'autonomous-development');
        transitionMaintenanceWork({ id: canaryAutonomous.id, status: 'canary' });

        const result = listMaintenanceWork({ status: 'canary', excludeRecipeId: 'autonomous-development' });
        expect(result.map(work => work.id)).toEqual([canaryOther.id]);
        expect(result.map(work => work.id)).not.toContain(proposed.id);
        expect(result.map(work => work.id)).not.toContain(canaryAutonomous.id);
    });
});

describe('maintenance store - canaryDeploymentState prevents pending/deployed canary starvation', () => {
    function pendingOutcome(): string {
        return JSON.stringify({ originalCommit: 'a'.repeat(40), changedPaths: ['lib/thing.ts'] });
    }
    function deployedOutcome(deadline: number): string {
        return JSON.stringify({
            originalCommit: 'a'.repeat(40),
            changedPaths: ['lib/thing.ts'],
            deployedRevision: 'b'.repeat(40),
            deployedAt: 1000,
            observationDeadlineAt: deadline,
        });
    }

    test("canaryDeploymentState: 'pending' filters at the SQL layer (before LIMIT), so a flood of already-deployed canaries can never starve not-yet-deployed ones out of a bounded page", () => {
        // Simulate many already-deployed autonomous canaries (being
        // observed/extended repeatedly - see evaluateAutonomousCanaries)
        // flooding the table, more than the bounded page size the deploy
        // step asks for.
        for (let i = 0; i < 25; i += 1) {
            const work = proposeMaintenanceWork(`deployed-issue-${i}`, 'autonomous-development');
            transitionMaintenanceWork({ id: work.id, status: 'canary', canaryOutcome: deployedOutcome(5000) });
        }
        // A single not-yet-deployed pending canary, created *before* the
        // flood, so it would be the oldest (and, if the deploy step only
        // filtered "already deployed" out in application code after a
        // small LIMIT sorted by updated_at DESC, the one most likely to be
        // silently starved out forever).
        const pending = proposeMaintenanceWork('pending-issue', 'autonomous-development');
        transitionMaintenanceWork({ id: pending.id, status: 'canary', canaryOutcome: pendingOutcome() });

        const filteredAtSqlLayer = listMaintenanceWork({
            status: 'canary',
            recipeId: 'autonomous-development',
            canaryDeploymentState: 'pending',
            orderBy: 'updated_asc',
            limit: 20,
        });
        expect(filteredAtSqlLayer.some(work => work.id === pending.id)).toBe(true);
        expect(filteredAtSqlLayer.every(work => JSON.parse(work.canaryOutcome ?? '{}').deployedRevision == null)).toBe(true);
    });

    test("canaryDeploymentState: 'deployed' filters at the SQL layer (before LIMIT), so a flood of not-yet-deployed pending canaries can never starve deployed ones out of a bounded page", () => {
        // Simulate many not-yet-deployed pending canaries flooding the
        // table - more than the bounded page size the evaluation step
        // asks for.
        for (let i = 0; i < 60; i += 1) {
            const work = proposeMaintenanceWork(`pending-issue-${i}`, 'autonomous-development');
            transitionMaintenanceWork({ id: work.id, status: 'canary', canaryOutcome: pendingOutcome() });
        }
        // A single already-deployed canary, created *before* the flood.
        const deployed = proposeMaintenanceWork('deployed-issue', 'autonomous-development');
        transitionMaintenanceWork({ id: deployed.id, status: 'canary', canaryOutcome: deployedOutcome(2000) });

        const filteredAtSqlLayer = listMaintenanceWork({
            status: 'canary',
            recipeId: 'autonomous-development',
            canaryDeploymentState: 'deployed',
            orderBy: 'canary_deadline_asc',
            limit: 50,
        });
        expect(filteredAtSqlLayer.some(work => work.id === deployed.id)).toBe(true);
        expect(filteredAtSqlLayer.every(work => JSON.parse(work.canaryOutcome ?? '{}').deployedRevision != null)).toBe(true);
    });

    test("'pending' treats a null canary_outcome the same as a canary_outcome without a deployedRevision", () => {
        const noOutcomeYet = proposeMaintenanceWork('issue-no-outcome', 'autonomous-development');
        transitionMaintenanceWork({ id: noOutcomeYet.id, status: 'canary' }); // canary_outcome left null
        const result = listMaintenanceWork({ status: 'canary', canaryDeploymentState: 'pending' });
        expect(result.map(work => work.id)).toContain(noOutcomeYet.id);
    });

    test("orderBy: 'updated_asc' returns the oldest-updated row first, even when it was extended least recently", () => {
        const first = proposeMaintenanceWork('issue-first', 'autonomous-development');
        transitionMaintenanceWork({ id: first.id, status: 'canary', canaryOutcome: pendingOutcome() });
        const second = proposeMaintenanceWork('issue-second', 'autonomous-development');
        transitionMaintenanceWork({ id: second.id, status: 'canary', canaryOutcome: pendingOutcome() });

        const result = listMaintenanceWork({ status: 'canary', canaryDeploymentState: 'pending', orderBy: 'updated_asc' });
        expect(result[0]?.id).toBe(first.id);
        expect(result[1]?.id).toBe(second.id);
    });

    test("orderBy: 'canary_deadline_asc' orders deployed canaries by soonest observationDeadlineAt first", () => {
        const late = proposeMaintenanceWork('issue-late-deadline', 'autonomous-development');
        transitionMaintenanceWork({ id: late.id, status: 'canary', canaryOutcome: deployedOutcome(9000) });
        const soon = proposeMaintenanceWork('issue-soon-deadline', 'autonomous-development');
        transitionMaintenanceWork({ id: soon.id, status: 'canary', canaryOutcome: deployedOutcome(1000) });

        const result = listMaintenanceWork({ status: 'canary', canaryDeploymentState: 'deployed', orderBy: 'canary_deadline_asc' });
        expect(result[0]?.id).toBe(soon.id);
        expect(result[1]?.id).toBe(late.id);
    });
});
