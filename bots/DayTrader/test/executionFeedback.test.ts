import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _resetRegistryForTests } from '../lib/registryDb';
import { listExecutionFeedback, recordExecutionFeedback } from '../lib/executionFeedback';

beforeEach(() => {
    _resetRegistryForTests(':memory:');
});

afterEach(() => {
    _resetRegistryForTests(':memory:');
});

describe('execution feedback', () => {
    test('records a feedback row linking workflow/step/directive/outcome/evidence', () => {
        const record = recordExecutionFeedback({
            workflowId: 'mine-runite',
            stepId: 'mine',
            directiveType: 'interact_loc',
            outcome: 'workflow_completed',
            evidence: ['runite ore +1'],
        });
        expect(record.workflowId).toBe('mine-runite');
        expect(record.stepId).toBe('mine');
        expect(record.directiveType).toBe('interact_loc');
        expect(record.outcome).toBe('workflow_completed');
        expect(record.evidence).toEqual(['runite ore +1']);
        expect(record.id).toBeGreaterThan(0);
    });

    test('links an issue id when provided', () => {
        const record = recordExecutionFeedback({
            issueId: 'issue-123',
            outcome: 'stall:blocked_ui:dismiss_ui',
            evidence: ['blocking UI stayed open without progress'],
        });
        expect(record.issueId).toBe('issue-123');
    });

    test('filters by workflowId, issueId, and time', () => {
        recordExecutionFeedback({ workflowId: 'a', outcome: 'x', evidence: [] });
        recordExecutionFeedback({ workflowId: 'b', outcome: 'y', evidence: [] });
        recordExecutionFeedback({ issueId: 'issue-1', outcome: 'z', evidence: [] });

        expect(listExecutionFeedback({ workflowId: 'a' }).length).toBe(1);
        expect(listExecutionFeedback({ issueId: 'issue-1' }).length).toBe(1);
        expect(listExecutionFeedback({ sinceMs: Date.now() + 1000 }).length).toBe(0);
        expect(listExecutionFeedback().length).toBe(3);
    });

    test('returns most recent feedback first', () => {
        recordExecutionFeedback({ outcome: 'first', evidence: [] });
        recordExecutionFeedback({ outcome: 'second', evidence: [] });
        const all = listExecutionFeedback();
        expect(all[0]?.outcome).toBe('second');
        expect(all[1]?.outcome).toBe('first');
    });
});
