// DayTrader - Development Review -> Typed Issue Bridge
//
// The development reviewer LLM is tool-free and can only emit structured
// findings (see developmentSchema.ts) - it can never emit code or directly
// mutate state. This module is the trusted deterministic translation layer
// that turns those findings into typed, tracked issue records. A 'success'
// finding means nothing is wrong, so it never becomes an issue.
//
// Ownership: every non-success technical finding (failure, policy_gap,
// knowledge_gap, upgrade, systemic_code) is owned by the development layer,
// regardless of which layer the reviewer thought should act (strategist,
// operator, workflow, development, or observer). The development layer runs
// an autonomous tool-enabled coding agent (see autonomousDevelopmentAgent.ts
// and maintenance/autonomousWorkerRunner.ts) that can investigate and repair
// unknown technical defects without a pre-authored recipe, so "no existing
// recipe" is never a reason to defer a finding to a human. The original
// target is preserved as context (not as an ownership decision) so the
// autonomous agent and any human reviewer can see who the reviewer thought
// was affected.
//
// This bridge never touches `escalation`-category issues: those are raised
// directly by escalationStore.ts for strategic goal-choice questions (what
// to buy, whether to accept a trade, which quest to pursue) and stay
// strategist-owned. Only an explicit `requires_direction` outcome from the
// autonomous coding agent itself - reserved for missing credentials/external
// authorization or irreversible product/policy decisions - can later
// re-route a *technical* issue to a human (see autonomousAgentSchema.ts).

import type { DevelopmentFinding } from './developmentSchema';
import { computeFingerprint, type IssueCategory, type RecordIssueInput } from './issueRegistry';

const CATEGORY_BY_KIND: Partial<Record<DevelopmentFinding['kind'], IssueCategory>> = {
    failure: 'failure',
    policy_gap: 'policy_gap',
    knowledge_gap: 'knowledge_gap',
    upgrade: 'upgrade',
    systemic_code: 'systemic_code',
};

/** Any standalone 13-digit run (an epoch-ms timestamp, valid until the year 2286) found anywhere in the text. */
const EPOCH_MS_PATTERN = /(?<![0-9])\d{13}(?![0-9])/g;

/**
 * Derives the newest evidence-occurrence timestamp cited by a finding's own
 * evidenceRefs, if any look like an epoch-ms (13-digit) timestamp. This is
 * the actual moment the underlying evidence happened, independent of when
 * the review that reports it happens to run - critical for canary rollback
 * decisions, which must never treat a review re-citing the exact same
 * historical evidence as a fresh post-deploy recurrence (see
 * maintenance/autonomousDeployment.ts).
 */
export function extractLatestEvidenceTimestamp(evidenceRefs: string[]): number | null {
    let latest: number | null = null;
    for (const ref of evidenceRefs) {
        const matches = ref.match(EPOCH_MS_PATTERN);
        if (!matches) continue;
        for (const match of matches) {
            const value = Number(match);
            if (Number.isFinite(value) && (latest === null || value > latest)) latest = value;
        }
    }
    return latest;
}

/**
 * Converts one development finding into a recordIssue() input, or null for
 * a 'success' finding (nothing to track). Pure and I/O-free so it is fully
 * unit-testable without touching the registry.
 *
 * Evidence without a true occurrence timestamp remains untimestamped. A
 * review's processing time or trace-window end is not evidence that the same
 * defect occurred again, and must never trigger a healthy canary rollback.
 */
export function findingToIssueInput(
    finding: DevelopmentFinding,
    reviewId: string
): RecordIssueInput | null {
    const category = CATEGORY_BY_KIND[finding.kind];
    if (!category) return null; // 'success' - no issue to raise
    return {
        // The fingerprint still includes the original target so distinct
        // findings about different layers never collide/dedupe into one
        // issue, even though ownership itself is now uniform.
        fingerprint: computeFingerprint(['development_finding', finding.target, finding.kind, finding.title]),
        ownerLayer: 'development',
        severity: finding.severity,
        category,
        title: finding.title,
        description: `[originally targeted at ${finding.target}] ${finding.diagnosis} Recommendation: ${finding.recommendation}`,
        evidence: [...finding.evidenceRefs, `development_finding_target:${finding.target}`],
        relatedReviewId: reviewId,
        evidenceAt: extractLatestEvidenceTimestamp(finding.evidenceRefs),
    };
}

export function findingsToIssueInputs(
    findings: DevelopmentFinding[],
    reviewId: string
): RecordIssueInput[] {
    return findings
        .map(finding => findingToIssueInput(finding, reviewId))
        .filter((input): input is RecordIssueInput => input !== null);
}
