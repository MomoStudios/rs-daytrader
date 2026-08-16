import { describe, expect, test } from 'bun:test';
import { extractLatestEvidenceTimestamp, findingToIssueInput, findingsToIssueInputs } from '../lib/developmentIssueBridge';
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

describe('development finding -> issue bridge (all technical findings are development-owned)', () => {
    test('a target=operator finding is still owned by development, not operator', () => {
        const input = findingToIssueInput(finding(), 'devreview-1');
        expect(input).not.toBeNull();
        expect(input?.category).toBe('failure');
        expect(input?.ownerLayer).toBe('development');
        expect(input?.severity).toBe('medium');
        expect(input?.relatedReviewId).toBe('devreview-1');
        expect(input?.description).toContain('Recommendation:');
        expect(input?.description).toContain('originally targeted at operator');
        expect(input?.evidence).toContain('development_finding_target:operator');
    });

    test('a target=strategist finding is owned by development, not strategist', () => {
        const input = findingToIssueInput(finding({ target: 'strategist', kind: 'upgrade' }), 'devreview-4');
        expect(input?.ownerLayer).toBe('development');
        expect(input?.category).toBe('upgrade');
        expect(input?.description).toContain('originally targeted at strategist');
    });

    test('a target=workflow finding is owned by development', () => {
        const input = findingToIssueInput(finding({ target: 'workflow', kind: 'policy_gap' }), 'devreview-2');
        expect(input?.ownerLayer).toBe('development');
        expect(input?.category).toBe('policy_gap');
    });

    test('a target=development finding (systemic code) is owned by development', () => {
        const input = findingToIssueInput(
            finding({ target: 'development', kind: 'systemic_code', title: 'sdk/API.md is stale' }),
            'devreview-systemic'
        );
        expect(input?.ownerLayer).toBe('development');
        expect(input?.category).toBe('systemic_code');
    });

    test('a target=observer finding is owned by development, not directly by a human', () => {
        // Observer-target findings used to become human-owned informational
        // notes. Unknown technical defects must never be deferred merely
        // because there's no pre-authored recipe or a human "should" look at
        // it - the autonomous coding agent gets first crack at every
        // technical finding. Only its own requires_direction outcome can
        // later re-route a specific issue to a human.
        const input = findingToIssueInput(finding({ target: 'observer', kind: 'knowledge_gap' }), 'devreview-3');
        expect(input?.ownerLayer).toBe('development');
        expect(input?.category).toBe('knowledge_gap');
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

    test('fingerprint still distinguishes findings by original target, even though ownership is uniform', () => {
        const operatorTarget = findingToIssueInput(finding({ target: 'operator' }), 'devreview-x');
        const strategistTarget = findingToIssueInput(finding({ target: 'strategist' }), 'devreview-x');
        expect(operatorTarget!.fingerprint).not.toBe(strategistTarget!.fingerprint);
        expect(operatorTarget!.ownerLayer).toBe(strategistTarget!.ownerLayer);
    });

    test('findingsToIssueInputs filters out success findings and keeps the rest, all development-owned', () => {
        const inputs = findingsToIssueInputs(
            [finding({ kind: 'success', title: 'Everything fine' }), finding({ kind: 'failure' }), finding({ kind: 'upgrade', target: 'strategist' })],
            'devreview-batch'
        );
        expect(inputs.length).toBe(2);
        expect(inputs.every(input => input.relatedReviewId === 'devreview-batch')).toBe(true);
        expect(inputs.every(input => input.ownerLayer === 'development')).toBe(true);
    });
});

describe('extractLatestEvidenceTimestamp', () => {
    test('returns null when no evidenceRef looks like an epoch-ms timestamp', () => {
        expect(extractLatestEvidenceTimestamp(['decision.jsonl:1234', 'no timestamp here'])).toBeNull();
        expect(extractLatestEvidenceTimestamp([])).toBeNull();
    });

    test('extracts a single 13-digit epoch-ms timestamp embedded in a ref', () => {
        expect(extractLatestEvidenceTimestamp(['trace_event:1700000000000'])).toBe(1700000000000);
    });

    test('returns the maximum across multiple refs and multiple matches within one ref', () => {
        expect(
            extractLatestEvidenceTimestamp([
                'trace_event:1700000000000',
                'trace_event:1700000005000 followed by 1700000009000',
                'decision.jsonl:42', // not 13 digits - ignored
            ])
        ).toBe(1700000009000);
    });

    test('ignores numbers that are not exactly 13 digits (e.g. line numbers, 10-digit unix seconds)', () => {
        expect(extractLatestEvidenceTimestamp(['decision.jsonl:424242', 'unix_seconds:1700000000'])).toBeNull();
        // A 14-digit run must not match either (digit-boundary check).
        expect(extractLatestEvidenceTimestamp(['17000000000001'])).toBeNull();
    });
});

describe('development finding -> issue bridge - evidenceAt derivation (finding occurrence tracking)', () => {
    test('derives evidenceAt from the finding\'s own evidenceRefs when present', () => {
        const input = findingToIssueInput(
            finding({ evidenceRefs: ['trace_event:1700000000000'] }),
            'devreview-evidence-1'
        );
        expect(input?.evidenceAt).toBe(1700000000000);
    });

    test('evidenceAt is null when there is no derivable occurrence timestamp', () => {
        const input = findingToIssueInput(finding({ evidenceRefs: ['decision.jsonl:1234'] }), 'devreview-evidence-3');
        expect(input?.evidenceAt).toBeNull();
    });

    test('findingsToIssueInputs leaves untimestamped evidence unknown', () => {
        const inputs = findingsToIssueInputs(
            [finding({ kind: 'failure', evidenceRefs: ['no ts'] }), finding({ kind: 'upgrade', evidenceRefs: ['also no ts'] })],
            'devreview-evidence-batch'
        );
        expect(inputs.every(input => input.evidenceAt === null)).toBe(true);
    });
});
