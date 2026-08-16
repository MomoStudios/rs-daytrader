// DayTrader - Registry Metrics
//
// Aggregates the issue registry, workflow candidate store, and maintenance
// work store into the small set of numbers that matter for observability
// and for feeding the development reviewer's trace: how much is still
// open, how long repairs take, how often problems recur, and how much of
// this still needs a human. Read-only; never mutates any record.

import {
    DEVELOPMENT_ELIGIBLE_CATEGORIES,
    listIssues,
    listOverdueIssues,
    type IssueOwnerLayer,
    type IssueStatus,
} from './issueRegistry';
import { listWorkflowCandidates, type WorkflowCandidateStatus } from './workflowCandidateStore';
import { listMaintenanceWork, type MaintenanceWorkStatus } from './maintenanceStore';

const AUTONOMOUS_RECIPE_ID = 'autonomous-development';

function countBy<T extends string>(values: T[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
    return counts;
}
/**
 * Minimal, tolerant read of the canary_outcome JSON blob (see
 * maintenance/autonomousDeployment.ts for the authoritative shape/writer).
 * Metrics must never throw on a malformed/missing blob - this is purely
 * observational.
 */
function readCanaryOutcome(value: string | null): { deployedRevision: string | null; observationDeadlineAt: number | null } {
    if (!value) return { deployedRevision: null, observationDeadlineAt: null };
    try {
        const parsed = JSON.parse(value) as { deployedRevision?: unknown; observationDeadlineAt?: unknown };
        return {
            deployedRevision: typeof parsed.deployedRevision === 'string' ? parsed.deployedRevision : null,
            observationDeadlineAt: typeof parsed.observationDeadlineAt === 'number' ? parsed.observationDeadlineAt : null,
        };
    } catch {
        return { deployedRevision: null, observationDeadlineAt: null };
    }
}

export interface RegistryMetrics {
    issues: {
        total: number;
        open: number;
        byStatus: Record<string, number>;
        byOwnerLayer: Record<string, number>;
        meanResolutionTimeMs: number | null;
        recurrenceTotal: number;
        overdueCount: number;
    };
    humanIntervention: {
        pendingHumanOwned: number;
        deferredCount: number;
        escalationsRaised: number;
        escalationsDeferred: number;
        /**
         * Development-owned technical issues (systemic_code/policy_gap/
         * knowledge_gap/failure/upgrade) re-routed to a human. Distinct from
         * escalations (strategic goal-choice questions) and from ordinary
         * `deferredCount` - this is specifically the autonomous coding
         * agent's own `requires_direction` outcome (missing credentials/
         * external authorization, or an irreversible product/policy
         * decision), never plain technical uncertainty.
         */
        requiresDirectionPending: number;
    };
    workflowCandidates: {
        total: number;
        byStatus: Record<string, number>;
        promotionRate: number | null;
    };
    maintenance: {
        total: number;
        byStatus: Record<string, number>;
    };
    /** The generic autonomous coding-agent repair pipeline, tracked separately from deterministic-recipe maintenance work. */
    autonomous: {
        /** Development-owned technical issues newly detected/triaged and awaiting an autonomous repair attempt. */
        queued: number;
        /** Autonomous canary commits built but not yet cherry-picked into the live checkout. */
        awaitingDeployment: number;
        /** Deployed autonomous canaries still inside their post-deployment observation window. */
        inObservation: number;
        /** Soonest observation deadline among in-observation canaries, if any. */
        nextCanaryDeadlineAt: number | null;
        /** Deployed autonomous canaries that were rolled back (redetection/regression/gate failure). */
        rolledBack: number;
        /** Development-owned issues currently in a bounded retry/backoff window after a failed autonomous attempt. */
        awaitingRetry: number;
        /** Soonest retry time among issues currently backing off, if any. */
        nextRetryAt: number | null;
        /** Total repair attempts accumulated across every development-owned technical issue (recipe + autonomous). */
        totalAttempts: number;
    };
}

export function computeRegistryMetrics(): RegistryMetrics {
    const issues = listIssues({ limit: 1000 });
    const statuses = issues.map(issue => issue.status as IssueStatus);
    const ownerLayers = issues.map(issue => issue.ownerLayer as IssueOwnerLayer);
    const resolved = issues.filter(issue => issue.status === 'resolved' && issue.resolvedAt !== null);
    const meanResolutionTimeMs =
        resolved.length > 0
            ? Math.round(
                  resolved.reduce((sum, issue) => sum + ((issue.resolvedAt ?? 0) - issue.firstDetectedAt), 0) /
                      resolved.length
              )
            : null;
    const recurrenceTotal = issues.reduce((sum, issue) => sum + issue.recurrenceCount, 0);

    const escalations = issues.filter(issue => issue.category === 'escalation');
    const developmentEligible = issues.filter(issue => DEVELOPMENT_ELIGIBLE_CATEGORIES.includes(issue.category));
    const requiresDirectionPending = developmentEligible.filter(
        issue => issue.ownerLayer === 'human' && issue.status !== 'resolved'
    ).length;

    const candidates = listWorkflowCandidates({ limit: 1000 });
    const candidateStatuses = candidates.map(candidate => candidate.status as WorkflowCandidateStatus);
    const decided = candidates.filter(
        candidate => candidate.status === 'promoted' || candidate.status === 'rejected' || candidate.status === 'rolled_back'
    );
    const promotionRate =
        decided.length > 0 ? decided.filter(candidate => candidate.status === 'promoted').length / decided.length : null;

    const maintenance = listMaintenanceWork({ limit: 1000 });
    const maintenanceStatuses = maintenance.map(item => item.status as MaintenanceWorkStatus);

    // Filtered at the SQL layer (recipeId, before any LIMIT) so a busy
    // deterministic-recipe queue can never starve autonomous canaries out
    // of this bounded page.
    const autonomousWork = listMaintenanceWork({ recipeId: AUTONOMOUS_RECIPE_ID, limit: 1000 });
    const autonomousCanaries = autonomousWork
        .filter(item => item.status === 'canary')
        .map(item => ({ item, outcome: readCanaryOutcome(item.canaryOutcome) }));
    const awaitingDeployment = autonomousCanaries.filter(({ outcome }) => !outcome.deployedRevision);
    const inObservation = autonomousCanaries.filter(({ outcome }) => outcome.deployedRevision);
    const nextCanaryDeadlineAt = inObservation
        .map(({ outcome }) => outcome.observationDeadlineAt)
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b)[0] ?? null;

    const backingOff = issues.filter(
        issue => issue.status === 'failed' && issue.ownerLayer === 'development' && issue.nextRetryAt !== null
    );
    const nextRetryAt =
        backingOff
            .map(issue => issue.nextRetryAt)
            .filter((value): value is number => value !== null)
            .sort((a, b) => a - b)[0] ?? null;

    return {
        issues: {
            total: issues.length,
            open: issues.filter(issue => !['resolved', 'rejected', 'deferred', 'failed'].includes(issue.status)).length,
            byStatus: countBy(statuses),
            byOwnerLayer: countBy(ownerLayers),
            meanResolutionTimeMs,
            recurrenceTotal,
            overdueCount: listOverdueIssues().length,
        },
        humanIntervention: {
            pendingHumanOwned: issues.filter(issue => issue.ownerLayer === 'human' && issue.status !== 'resolved').length,
            deferredCount: issues.filter(issue => issue.status === 'deferred').length,
            escalationsRaised: escalations.length,
            escalationsDeferred: escalations.filter(issue => issue.status === 'deferred').length,
            requiresDirectionPending,
        },
        workflowCandidates: {
            total: candidates.length,
            byStatus: countBy(candidateStatuses),
            promotionRate,
        },
        maintenance: {
            total: maintenance.length,
            byStatus: countBy(maintenanceStatuses),
        },
        autonomous: {
            queued: developmentEligible.filter(issue => issue.status === 'detected' || issue.status === 'triaged').length,
            awaitingDeployment: awaitingDeployment.length,
            inObservation: inObservation.length,
            nextCanaryDeadlineAt,
            rolledBack: autonomousWork.filter(item => item.status === 'rolled_back').length,
            awaitingRetry: backingOff.length,
            nextRetryAt,
            totalAttempts: developmentEligible.reduce((sum, issue) => sum + issue.attempts, 0),
        },
    };
}
