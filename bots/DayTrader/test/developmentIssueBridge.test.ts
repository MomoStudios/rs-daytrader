import { describe, expect, test } from 'bun:test';
import { findingToIssueInput, findingsToIssueInputs } from '../lib/developmentIssueBridge';
import type { DevelopmentFinding } from '../lib/developmentSchema';

function finding(overrides: Partial<DevelopmentFinding> = {}): DevelopmentFinding {
    return {
        severity: 'medium',
        kind: 'failure',
        title: 'Operator repeatedly fails to open Draynor bank',
        evidenceRefs: ['decision.jsonl:1234'],
        diagnosis: 'The bank booth interaction option text differs from what the workflow expects.',
        recommendation: 'Use the exact visible option text reported by state.nearbyObjects.',
        target: 'operator',
        ...overrides,
    };
}

describe('development finding -> issue bridge', () => {
    test('maps a failure finding to a failure-category issue owned by the target layer', () => {
        const input = findingToIssueInput(finding(), 'devreview-1');
        expect(input).not.toBeNull();
        expect(input?.category).toBe('failure');
        expect(input?.ownerLayer).toBe('operator');
        expect(input?.severity).toBe('medium');
        expect(input?.relatedReviewId).toBe('devreview-1');
        expect(input?.description).toContain('Recommendation:');
    });

    test('maps target=workflow findings to ownerLayer=development', () => {
        const input = findingToIssueInput(finding({ target: 'workflow', kind: 'policy_gap' }), 'devreview-2');
        expect(input?.ownerLayer).toBe('development');
        expect(input?.category).toBe('policy_gap');
    });

    test('routes systemic code findings to the development maintenance queue', () => {
        const input = findingToIssueInput(
            finding({ target: 'development', kind: 'systemic_code', title: 'sdk/API.md is stale' }),
            'devreview-systemic'
        );
        expect(input?.ownerLayer).toBe('development');
        expect(input?.category).toBe('systemic_code');
    });

    test('maps target=observer findings to ownerLayer=human', () => {
        const input = findingToIssueInput(finding({ target: 'observer', kind: 'knowledge_gap' }), 'devreview-3');
        expect(input?.ownerLayer).toBe('human');
        expect(input?.category).toBe('knowledge_gap');
    });

    test('maps target=strategist findings to ownerLayer=strategist', () => {
        const input = findingToIssueInput(finding({ target: 'strategist', kind: 'upgrade' }), 'devreview-4');
        expect(input?.ownerLayer).toBe('strategist');
        expect(input?.category).toBe('upgrade');
    });

    test('a success finding produces no issue at all', () => {
        expect(findingToIssueInput(finding({ kind: 'success' }), 'devreview-5')).toBeNull();
    });

    test('fingerprint is stable across identical findings and differs across distinct ones', () => {
        const a = findingToIssueInput(finding(), 'devreview-a');
        const b = findingToIssueInput(finding(), 'devreview-b');
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        expect(a!.fingerprint).toBe(b!.fingerprint); // same target/kind/title -> same underlying issue
        const c = findingToIssueInput(finding({ title: 'A completely different problem' }), 'devreview-a');
        expect(c!.fingerprint).not.toBe(a!.fingerprint);
    });

    test('findingsToIssueInputs filters out success findings and keeps the rest', () => {
        const inputs = findingsToIssueInputs(
            [finding({ kind: 'success', title: 'Everything fine' }), finding({ kind: 'failure' }), finding({ kind: 'upgrade', target: 'strategist' })],
            'devreview-batch'
        );
        expect(inputs.length).toBe(2);
        expect(inputs.every(input => input.relatedReviewId === 'devreview-batch')).toBe(true);
    });
});
