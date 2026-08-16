import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { _resetRegistryForTests } from '../lib/registryDb';
import { recordIssue, transitionIssue } from '../lib/issueRegistry';
import { proposeWorkflowCandidate, recordWorkflowCandidateOutcome } from '../lib/workflowCandidateStore';
import { proposeMaintenanceWork, transitionMaintenanceWork } from '../lib/maintenanceStore';
import { computeRegistryMetrics } from '../lib/registryMetrics';
import { _setWorkflowsDataDirForTests, workflowHash } from '../lib/workflowStore';
import type { OperatorWorkflow } from '../lib/operatorSchema';

const DATA_DIR = join(import.meta.dir, '..', 'data');
let tempDir: string;

beforeEach(() => {
    _resetRegistryForTests(':memory:');
    tempDir = mkdtempSync(join(DATA_DIR, 'metrics-test-'));
    _setWorkflowsDataDirForTests(tempDir);
});

afterEach(() => {
    _resetRegistryForTests(':memory:');
    rmSync(tempDir, { recursive: true, force: true });
});

function workflow(name: string): OperatorWorkflow {
    return {
        name,
        goal: 'test goal',
        reusable: true,
        version: 1,
        successCriteria: ['done'],
        steps: [
            {
                id: 'step',
                description: 'a step',
                directive: { type: 'wait', ticks: 1 },
                completion: { type: 'action_success' },
                repeatUntilComplete: false,
                maxAttempts: 1,
            },
        ],
    };
}

describe('registry metrics - issues', () => {
    test('reports zeroed metrics on an empty registry', () => {
        const metrics = computeRegistryMetrics();
        expect(metrics.issues.total).toBe(0);
        expect(metrics.issues.meanResolutionTimeMs).toBeNull();
        expect(metrics.workflowCandidates.promotionRate).toBeNull();
    });

    test('counts open vs resolved issues and computes mean resolution time', () => {
        const a = recordIssue({
            fingerprint: 'a',
            ownerLayer: 'operator',
            severity: 'medium',
            category: 'failure',
            title: 'a',
            description: 'a',
            evidence: [],
        });
        recordIssue({
            fingerprint: 'b',
            ownerLayer: 'operator',
            severity: 'low',
            category: 'failure',
            title: 'b',
            description: 'b',
            evidence: [],
        });
        transitionIssue({ id: a.id, status: 'resolved', resolutionEvidence: 'fixed' });

        const metrics = computeRegistryMetrics();
        expect(metrics.issues.total).toBe(2);
        expect(metrics.issues.open).toBe(1);
        expect(metrics.issues.byStatus.resolved).toBe(1);
        expect(metrics.issues.byStatus.detected).toBe(1);
        expect(metrics.issues.meanResolutionTimeMs).toBeGreaterThanOrEqual(0);
    });

    test('tracks recurrence totals across reopened issues', () => {
        const issue = recordIssue({
            fingerprint: 'recurring',
            ownerLayer: 'operator',
            severity: 'medium',
            category: 'failure',
            title: 'recurring problem',
            description: 'd',
            evidence: [],
        });
        transitionIssue({ id: issue.id, status: 'resolved' });
        recordIssue({
            fingerprint: 'recurring',
            ownerLayer: 'operator',
            severity: 'medium',
            category: 'failure',
            title: 'recurring problem',
            description: 'd',
            evidence: ['again'],
        });
        expect(computeRegistryMetrics().issues.recurrenceTotal).toBe(1);
    });

    test('counts overdue issues past their deadline', () => {
        recordIssue({
            fingerprint: 'overdue',
            ownerLayer: 'operator',
            severity: 'high',
            category: 'failure',
            title: 'overdue',
            description: 'd',
            evidence: [],
            deadlineAt: Date.now() - 1,
        });
        expect(computeRegistryMetrics().issues.overdueCount).toBe(1);
    });
});

describe('registry metrics - human intervention', () => {
    test('counts human-owned and deferred issues, and escalation timeouts', () => {
        recordIssue({
            fingerprint: 'human-1',
            ownerLayer: 'human',
            severity: 'low',
            category: 'knowledge_gap',
            title: 'needs a human',
            description: 'd',
            evidence: [],
        });
        const escalation = recordIssue({
            fingerprint: 'esc-1',
            ownerLayer: 'strategist',
            severity: 'medium',
            category: 'escalation',
            title: 'escalation',
            description: 'd',
            evidence: [],
        });
        transitionIssue({ id: escalation.id, status: 'deferred', resolutionEvidence: 'timed out' });

        const metrics = computeRegistryMetrics();
        expect(metrics.humanIntervention.pendingHumanOwned).toBe(1);
        expect(metrics.humanIntervention.escalationsRaised).toBe(1);
        expect(metrics.humanIntervention.escalationsDeferred).toBe(1);
        expect(metrics.humanIntervention.deferredCount).toBe(1);
    });
});

describe('registry metrics - workflow candidates and maintenance', () => {
    test('computes promotion rate across decided candidates', () => {
        const promotedFlow = workflow('promoted-flow');
        const rejectedFlow = workflow('rejected-flow');
        proposeWorkflowCandidate({ workflow: promotedFlow, source: 'operator_plan' });
        proposeWorkflowCandidate({ workflow: rejectedFlow, source: 'operator_plan' });

        recordWorkflowCandidateOutcome(workflowHash(promotedFlow), 'success', undefined, 1);
        recordWorkflowCandidateOutcome(workflowHash(rejectedFlow), 'failure', 'broke');

        const metrics = computeRegistryMetrics();
        expect(metrics.workflowCandidates.total).toBe(2);
        expect(metrics.workflowCandidates.promotionRate).toBe(0.5);
    });

    test('summarizes maintenance work by status', () => {
        const work = proposeMaintenanceWork('issue-x', 'regenerate-api-docs');
        transitionMaintenanceWork({ id: work.id, status: 'canary' });
        const metrics = computeRegistryMetrics();
        expect(metrics.maintenance.total).toBe(1);
        expect(metrics.maintenance.byStatus.canary).toBe(1);
    });
});

describe('registry metrics - autonomous development pipeline', () => {
    test('counts queued development-owned technical issues awaiting an autonomous attempt', () => {
        recordIssue({
            fingerprint: 'autonomous-queued',
            ownerLayer: 'development',
            severity: 'medium',
            category: 'failure',
            title: 'Queued technical issue',
            description: 'test',
            evidence: [],
        });
        const metrics = computeRegistryMetrics();
        expect(metrics.autonomous.queued).toBe(1);
    });

    test('separates canaries awaiting deployment from canaries in observation, and reports the soonest deadline', () => {
        const awaiting = proposeMaintenanceWork('issue-awaiting', 'autonomous-development');
        transitionMaintenanceWork({ id: awaiting.id, status: 'canary', canaryOutcome: JSON.stringify({ awaitingDeployment: true }) });

        const deployed = proposeMaintenanceWork('issue-deployed', 'autonomous-development');
        transitionMaintenanceWork({
            id: deployed.id,
            status: 'canary',
            canaryOutcome: JSON.stringify({ deployedRevision: 'a'.repeat(40), observationDeadlineAt: 12345 }),
        });

        const metrics = computeRegistryMetrics();
        expect(metrics.autonomous.awaitingDeployment).toBe(1);
        expect(metrics.autonomous.inObservation).toBe(1);
        expect(metrics.autonomous.nextCanaryDeadlineAt).toBe(12345);
    });

    test('counts rolled-back autonomous canaries separately', () => {
        const work = proposeMaintenanceWork('issue-rolled-back', 'autonomous-development');
        transitionMaintenanceWork({ id: work.id, status: 'rolled_back' });
        const metrics = computeRegistryMetrics();
        expect(metrics.autonomous.rolledBack).toBe(1);
    });

    test('reports issues awaiting retry/backoff and the soonest retry time, distinct from deferred/human-owned counts', () => {
        const issue = recordIssue({
            fingerprint: 'autonomous-backoff',
            ownerLayer: 'development',
            severity: 'medium',
            category: 'failure',
            title: 'Failed autonomous attempt',
            description: 'test',
            evidence: [],
        });
        transitionIssue({ id: issue.id, status: 'failed', nextRetryAt: 99999 });

        const metrics = computeRegistryMetrics();
        expect(metrics.autonomous.awaitingRetry).toBe(1);
        expect(metrics.autonomous.nextRetryAt).toBe(99999);
        expect(metrics.humanIntervention.pendingHumanOwned).toBe(0); // stays development-owned, never counted as human-pending
    });

    test('reports requires_direction issues separately from escalations and ordinary deferrals', () => {
        recordIssue({
            fingerprint: 'requires-direction-metric',
            ownerLayer: 'human',
            severity: 'medium',
            category: 'failure', // a technical category re-routed by requires_direction, not an escalation
            title: 'Needs an external credential',
            description: 'test',
            evidence: [],
        });
        const metrics = computeRegistryMetrics();
        expect(metrics.humanIntervention.requiresDirectionPending).toBe(1);
        expect(metrics.humanIntervention.escalationsRaised).toBe(0);
    });

    test('sums attempts across development-owned technical issues', () => {
        const issue = recordIssue({
            fingerprint: 'attempts-issue',
            ownerLayer: 'development',
            severity: 'medium',
            category: 'upgrade',
            title: 'Multi-attempt issue',
            description: 'test',
            evidence: [],
        });
        transitionIssue({ id: issue.id, status: 'repairing', incrementAttempts: true });
        transitionIssue({ id: issue.id, status: 'failed', incrementAttempts: true, nextRetryAt: 1000 });
        const metrics = computeRegistryMetrics();
        expect(metrics.autonomous.totalAttempts).toBe(2);
    });

    test('reports zeroed autonomous metrics on an empty registry', () => {
        const metrics = computeRegistryMetrics();
        expect(metrics.autonomous).toEqual({
            queued: 0,
            awaitingDeployment: 0,
            inObservation: 0,
            nextCanaryDeadlineAt: null,
            rolledBack: 0,
            awaitingRetry: 0,
            nextRetryAt: null,
            totalAttempts: 0,
        });
    });
});
