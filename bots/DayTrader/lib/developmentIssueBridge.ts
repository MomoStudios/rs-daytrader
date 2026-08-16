// DayTrader - Development Review -> Typed Issue Bridge
//
// The development reviewer LLM is tool-free and can only emit structured
// findings (see developmentSchema.ts) - it can never emit code or directly
// mutate state. This module is the trusted deterministic translation layer
// that turns those findings into typed, tracked issue records. A 'success'
// finding means nothing is wrong, so it never becomes an issue.

import type { DevelopmentFinding } from './developmentSchema';
import { computeFingerprint, type IssueCategory, type IssueOwnerLayer, type RecordIssueInput } from './issueRegistry';

const CATEGORY_BY_KIND: Partial<Record<DevelopmentFinding['kind'], IssueCategory>> = {
    failure: 'failure',
    policy_gap: 'policy_gap',
    knowledge_gap: 'knowledge_gap',
    upgrade: 'upgrade',
    systemic_code: 'systemic_code',
};

const OWNER_BY_TARGET: Record<DevelopmentFinding['target'], IssueOwnerLayer> = {
    strategist: 'strategist',
    operator: 'operator',
    // A workflow-shaped gap is owned by the development layer: the fix is a
    // new/repaired workflow candidate, not a live strategist/operator call.
    workflow: 'development',
    development: 'development',
    // Observer-target findings are informational for a human operator.
    observer: 'human',
};

/**
 * Converts one development finding into a recordIssue() input, or null for
 * a 'success' finding (nothing to track). Pure and I/O-free so it is fully
 * unit-testable without touching the registry.
 */
export function findingToIssueInput(finding: DevelopmentFinding, reviewId: string): RecordIssueInput | null {
    const category = CATEGORY_BY_KIND[finding.kind];
    if (!category) return null; // 'success' - no issue to raise
    return {
        fingerprint: computeFingerprint(['development_finding', finding.target, finding.kind, finding.title]),
        ownerLayer: OWNER_BY_TARGET[finding.target],
        severity: finding.severity,
        category,
        title: finding.title,
        description: `${finding.diagnosis} Recommendation: ${finding.recommendation}`,
        evidence: finding.evidenceRefs,
        relatedReviewId: reviewId,
    };
}

export function findingsToIssueInputs(findings: DevelopmentFinding[], reviewId: string): RecordIssueInput[] {
    return findings
        .map(finding => findingToIssueInput(finding, reviewId))
        .filter((input): input is RecordIssueInput => input !== null);
}
