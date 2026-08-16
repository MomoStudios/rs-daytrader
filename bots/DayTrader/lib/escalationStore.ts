// DayTrader - Escalation Ownership
//
// Replaces "escalation as a global unowned flag" with an identified,
// tracked issue: every escalation is a typed issue (category='escalation')
// with an owner layer, status, deadline, and resolution, backed by the
// same SQLite registry as every other systemic issue. operator.json still
// carries `pendingEscalation` for backward-compatible JSON consumers (the
// observer dashboard, the main loop's "pause execution" guard), but this
// module is the only thing allowed to set/clear it, and every clear is
// paired with an explicit resolution reason.

import type { OperatorEscalation } from './operatorSchema';
import {
    clearOperatorEscalation,
    loadOperatorState,
    setOperatorEscalation,
} from './operatorStore';
import {
    computeFingerprint,
    getIssue,
    recordIssue,
    severityDeadlineMs,
    transitionIssue,
    type IssueRecord,
} from './issueRegistry';
import { log } from './logger';

function fingerprintFor(escalation: OperatorEscalation): string {
    return computeFingerprint(['escalation', escalation.reason, escalation.question]);
}

/**
 * Raise (or re-raise/dedupe) an operator escalation. Creates/reopens a
 * typed issue owned by the strategist layer with a bounded deadline, links
 * it on operator runtime state, and keeps the legacy JSON flag in sync.
 */
export function raiseOperatorEscalation(escalation: OperatorEscalation, relatedIssueId?: string | null): IssueRecord {
    const severity = escalation.reason === 'unsafe' || escalation.reason === 'policy_violation' ? 'high' : 'medium';
    const issue = recordIssue({
        fingerprint: fingerprintFor(escalation),
        ownerLayer: 'strategist',
        severity,
        category: 'escalation',
        title: `Operator escalation: ${escalation.reason}`,
        description: escalation.question,
        evidence: escalation.evidence,
        deadlineAt: severityDeadlineMs(severity),
        relatedWorkflowId: relatedIssueId ?? null,
    });
    const triaged = transitionIssue({ id: issue.id, status: 'triaged', note: 'awaiting strategist acknowledgement' });
    setOperatorEscalation(escalation, triaged.id);
    log('operator_escalation', { ...escalation, issueId: triaged.id, deadlineAt: triaged.deadlineAt });
    return triaged;
}

/**
 * Explicitly acknowledge/resolve the currently pending escalation (if any)
 * because the strategist replaced/answered it. Safe to call even when no
 * escalation is pending. Never called implicitly by an unrelated reset.
 */
export function acknowledgeOperatorEscalation(resolutionSummary: string): IssueRecord | null {
    const runtime = loadOperatorState();
    const issueId = runtime.pendingEscalationIssueId;
    clearOperatorEscalation();
    if (!issueId) return null;
    const issue = getIssue(issueId);
    if (!issue || !isOpen(issue.status)) return issue;
    const resolved = transitionIssue({
        id: issueId,
        status: 'resolved',
        resolutionEvidence: resolutionSummary,
    });
    log('operator_escalation_acknowledged', { issueId, resolutionSummary });
    return resolved;
}

function isOpen(status: IssueRecord['status']): boolean {
    return status !== 'resolved' && status !== 'rejected' && status !== 'deferred' && status !== 'failed';
}

export interface EscalationTimeoutResult {
    timedOut: boolean;
    issue: IssueRecord | null;
}

/**
 * Deterministic timeout handling: if the pending escalation's deadline has
 * passed, the escalation is force-cleared (never left waiting forever) and
 * the underlying issue is deferred for human review instead of being
 * silently forgotten. Execution safety is preserved because clearing the
 * escalation only unblocks *planning*; the workflow that led to the
 * escalation was already reset to null before the escalation was raised.
 */
export function checkOperatorEscalationTimeout(now = Date.now()): EscalationTimeoutResult {
    const runtime = loadOperatorState();
    if (!runtime.pendingEscalation || !runtime.pendingEscalationIssueId) {
        return { timedOut: false, issue: null };
    }
    const issue = getIssue(runtime.pendingEscalationIssueId);
    if (!issue || !issue.deadlineAt || issue.deadlineAt > now) {
        return { timedOut: false, issue };
    }
    clearOperatorEscalation();
    const deferred = transitionIssue({
        id: issue.id,
        status: 'deferred',
        note: 'escalation deadline passed without strategist acknowledgement',
        resolutionEvidence: 'auto-deferred to human review after timeout; strategist planning resumed',
    });
    log('operator_escalation_timeout', { issueId: issue.id, deadlineAt: issue.deadlineAt, now });
    return { timedOut: true, issue: deferred };
}
