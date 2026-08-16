// DayTrader - Registry Metrics
//
// Aggregates the issue registry, workflow candidate store, and maintenance
// work store into the small set of numbers that matter for observability
// and for feeding the development reviewer's trace: how much is still
// open, how long repairs take, how often problems recur, and how much of
// this still needs a human. Read-only; never mutates any record.

import { listIssues, listOverdueIssues, type IssueOwnerLayer, type IssueStatus } from './issueRegistry';
import { listWorkflowCandidates, type WorkflowCandidateStatus } from './workflowCandidateStore';
import { listMaintenanceWork, type MaintenanceWorkStatus } from './maintenanceStore';

function countBy<T extends string>(values: T[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
    return counts;
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

    const candidates = listWorkflowCandidates({ limit: 1000 });
    const candidateStatuses = candidates.map(candidate => candidate.status as WorkflowCandidateStatus);
    const decided = candidates.filter(
        candidate => candidate.status === 'promoted' || candidate.status === 'rejected' || candidate.status === 'rolled_back'
    );
    const promotionRate =
        decided.length > 0 ? decided.filter(candidate => candidate.status === 'promoted').length / decided.length : null;

    const maintenance = listMaintenanceWork({ limit: 1000 });
    const maintenanceStatuses = maintenance.map(item => item.status as MaintenanceWorkStatus);

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
    };
}
