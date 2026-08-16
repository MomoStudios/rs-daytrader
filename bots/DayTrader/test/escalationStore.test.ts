import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { _resetRegistryForTests } from '../lib/registryDb';
import { _resetOperatorStateForTests, loadOperatorState, resetOperatorWorkflow } from '../lib/operatorStore';
import { _setLogDataDirForTests } from '../lib/logger';
import {
    acknowledgeOperatorEscalation,
    checkOperatorEscalationTimeout,
    raiseOperatorEscalation,
} from '../lib/escalationStore';
import { getIssue, listIssues } from '../lib/issueRegistry';
import type { OperatorEscalation } from '../lib/operatorSchema';

const DATA_DIR = join(import.meta.dir, '..', 'data');
let tempDir: string;

beforeEach(() => {
    _resetRegistryForTests(':memory:');
    tempDir = mkdtempSync(join(DATA_DIR, 'escalation-test-'));
    _resetOperatorStateForTests(tempDir);
    _setLogDataDirForTests(tempDir);
});

afterEach(() => {
    _resetRegistryForTests(':memory:');
    rmSync(tempDir, { recursive: true, force: true });
});

function escalation(overrides: Partial<OperatorEscalation> = {}): OperatorEscalation {
    return {
        reason: 'repeated_failure',
        question: 'Should the strategist replace this workflow?',
        evidence: ['step failed 5 times'],
        suggestedOptions: ['pick a new goal'],
        ...overrides,
    };
}

describe('escalation store - ownership and lifecycle', () => {
    test('raising an escalation creates a triaged issue owned by the strategist with a deadline', () => {
        const issue = raiseOperatorEscalation(escalation());
        expect(issue.status).toBe('triaged');
        expect(issue.ownerLayer).toBe('strategist');
        expect(issue.category).toBe('escalation');
        expect(issue.deadlineAt).toBeGreaterThan(Date.now());
        expect(loadOperatorState().pendingEscalation).not.toBeNull();
        expect(loadOperatorState().pendingEscalationIssueId).toBe(issue.id);
    });

    test('raising the same escalation twice dedupes to the same issue', () => {
        const first = raiseOperatorEscalation(escalation());
        const second = raiseOperatorEscalation(escalation());
        expect(second.id).toBe(first.id);
        expect(listIssues({ category: 'escalation' }).length).toBe(1);
    });

    test('acknowledging resolves the tracked issue and clears the JSON flag', () => {
        const issue = raiseOperatorEscalation(escalation());
        const resolved = acknowledgeOperatorEscalation('strategist chose a new goal');
        expect(resolved?.id).toBe(issue.id);
        expect(resolved?.status).toBe('resolved');
        expect(resolved?.resolutionEvidence).toBe('strategist chose a new goal');
        expect(loadOperatorState().pendingEscalation).toBeNull();
        expect(loadOperatorState().pendingEscalationIssueId).toBeNull();
    });

    test('acknowledging with nothing pending is a safe no-op', () => {
        expect(acknowledgeOperatorEscalation('nothing to do')).toBeNull();
    });

    test('resetOperatorWorkflow never silently clears a pending escalation', () => {
        raiseOperatorEscalation(escalation());
        resetOperatorWorkflow();
        expect(loadOperatorState().pendingEscalation).not.toBeNull();
        const openEscalations = listIssues({ category: 'escalation', openOnly: true });
        expect(openEscalations.length).toBe(1);
    });

    test('a recurring escalation after resolution reopens with incremented recurrenceCount', () => {
        const first = raiseOperatorEscalation(escalation());
        acknowledgeOperatorEscalation('resolved once');
        const reopened = raiseOperatorEscalation(escalation());
        expect(reopened.id).toBe(first.id);
        expect(reopened.recurrenceCount).toBe(1);
        expect(reopened.status).toBe('triaged');
    });
});

describe('escalation store - timeout handling', () => {
    test('an escalation past its deadline times out, defers the issue, and clears the flag', () => {
        const issue = raiseOperatorEscalation(escalation());
        const result = checkOperatorEscalationTimeout(issue.deadlineAt! + 1);
        expect(result.timedOut).toBe(true);
        expect(result.issue?.status).toBe('deferred');
        expect(loadOperatorState().pendingEscalation).toBeNull();
        expect(getIssue(issue.id)?.status).toBe('deferred');
    });

    test('an escalation before its deadline does not time out', () => {
        raiseOperatorEscalation(escalation());
        const result = checkOperatorEscalationTimeout(Date.now());
        expect(result.timedOut).toBe(false);
        expect(loadOperatorState().pendingEscalation).not.toBeNull();
    });

    test('no pending escalation means no timeout work happens', () => {
        const result = checkOperatorEscalationTimeout();
        expect(result.timedOut).toBe(false);
        expect(result.issue).toBeNull();
    });
});
