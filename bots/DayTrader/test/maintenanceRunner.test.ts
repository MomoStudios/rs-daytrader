import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _resetRegistryForTests } from '../lib/registryDb';
import { recordIssue, transitionIssue } from '../lib/issueRegistry';
import { eligibleCandidates } from '../maintenance/runner';

beforeEach(() => {
    _resetRegistryForTests(':memory:');
});

afterEach(() => {
    _resetRegistryForTests(':memory:');
});

describe('maintenance runner - eligibleCandidates scans every development-owned technical category', () => {
    test('includes systemic_code, policy_gap, knowledge_gap, failure, and upgrade issues', () => {
        const categories = ['systemic_code', 'policy_gap', 'knowledge_gap', 'failure', 'upgrade'] as const;
        const created = categories.map(category =>
            recordIssue({
                fingerprint: `eligible-${category}`,
                ownerLayer: 'development',
                severity: 'medium',
                category,
                title: `Issue in ${category}`,
                description: 'test',
                evidence: [],
            })
        );
        const ids = eligibleCandidates().map(issue => issue.id);
        for (const issue of created) {
            expect(ids).toContain(issue.id);
        }
    });

    test('excludes escalation, workflow, reservation_violation, and transient_fault categories', () => {
        const excluded = ['escalation', 'workflow', 'reservation_violation', 'transient_fault'] as const;
        for (const category of excluded) {
            recordIssue({
                fingerprint: `excluded-${category}`,
                ownerLayer: 'development',
                severity: 'medium',
                category,
                title: `Issue in ${category}`,
                description: 'test',
                evidence: [],
            });
        }
        expect(eligibleCandidates().length).toBe(0);
    });

    test('excludes issues not owned by development', () => {
        recordIssue({
            fingerprint: 'operator-owned-failure',
            ownerLayer: 'operator',
            severity: 'medium',
            category: 'failure',
            title: 'Operator-owned failure',
            description: 'test',
            evidence: [],
        });
        expect(eligibleCandidates().length).toBe(0);
    });

    test('excludes issues already in progress (repairing/canary/validating) or terminal', () => {
        const inProgress = recordIssue({
            fingerprint: 'in-progress-issue',
            ownerLayer: 'development',
            severity: 'medium',
            category: 'failure',
            title: 'Already being repaired',
            description: 'test',
            evidence: [],
        });
        transitionIssue({ id: inProgress.id, status: 'repairing' });

        const resolved = recordIssue({
            fingerprint: 'resolved-issue',
            ownerLayer: 'development',
            severity: 'medium',
            category: 'failure',
            title: 'Already resolved',
            description: 'test',
            evidence: [],
        });
        transitionIssue({ id: resolved.id, status: 'resolved' });

        expect(eligibleCandidates().length).toBe(0);
    });
});
