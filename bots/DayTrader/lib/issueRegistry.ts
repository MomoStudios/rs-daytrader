// DayTrader - Typed Issue Registry
//
// Persistent, fingerprinted issue tracking shared by every DayTrader
// process (development reviewer, operator remediation, escalation
// ownership, maintenance worker). Backed by bun:sqlite (see registryDb.ts)
// so multiple OS processes can detect, dedupe, reopen, and transition the
// same issue without racing each other or silently losing history.
//
// Lifecycle: detected -> triaged -> repairing -> validating -> canary ->
// resolved | rejected | deferred | failed. `deferred`/`failed`/`rejected`
// issues can be reopened (fingerprint match) if the same problem recurs,
// which increments recurrenceCount instead of creating a duplicate row.

import { createHash } from 'crypto';
import type { SQLQueryBindings } from 'bun:sqlite';
import { getRegistryDb, newRegistryId, withTransaction, RegistryError } from './registryDb';

export type IssueStatus =
    | 'detected'
    | 'triaged'
    | 'repairing'
    | 'validating'
    | 'canary'
    | 'resolved'
    | 'rejected'
    | 'deferred'
    | 'failed';

export type IssueOwnerLayer = 'deterministic' | 'operator' | 'strategist' | 'development' | 'human';

export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';

export type IssueCategory =
    | 'escalation'
    | 'workflow'
    | 'systemic_code'
    | 'policy_gap'
    | 'knowledge_gap'
    | 'failure'
    | 'reservation_violation'
    | 'transient_fault'
    | 'upgrade';

/**
 * The exact five technical categories the development layer autonomously
 * repairs (deterministic recipe first, generic autonomous coding agent as
 * the default fallback - see maintenance/autonomousWorkerRunner.ts).
 * `escalation` (strategic goal-choice questions), `workflow` (game-execution
 * recipes), `reservation_violation`, and `transient_fault` are handled by
 * their own owning layer/mechanism and are never picked up here.
 */
export const DEVELOPMENT_ELIGIBLE_CATEGORIES: IssueCategory[] = [
    'systemic_code',
    'policy_gap',
    'knowledge_gap',
    'failure',
    'upgrade',
];

const TERMINAL_REOPENABLE_STATUSES = new Set<IssueStatus>(['resolved', 'rejected', 'deferred', 'failed']);
const OPEN_STATUSES = new Set<IssueStatus>(['detected', 'triaged', 'repairing', 'validating', 'canary']);

export interface IssueRecord {
    id: string;
    fingerprint: string;
    status: IssueStatus;
    ownerLayer: IssueOwnerLayer;
    severity: IssueSeverity;
    category: IssueCategory;
    title: string;
    description: string;
    evidence: string[];
    deadlineAt: number | null;
    attempts: number;
    resolutionEvidence: string | null;
    relatedWorkflowId: string | null;
    relatedReviewId: string | null;
    recurrenceCount: number;
    firstDetectedAt: number;
    lastDetectedAt: number;
    resolvedAt: number | null;
    createdAt: number;
    updatedAt: number;
    /**
     * When set (only meaningful while status='failed'), the autonomous
     * development pipeline's bounded circuit-breaker/backoff policy is
     * telling the maintenance worker not to retry this issue again before
     * this timestamp. Technical failure is never silently converted to
     * human ownership: it stays owner_layer='development' and is
     * automatically reopened/retried once this deadline passes.
     */
    nextRetryAt: number | null;
    /**
     * The newest evidence-occurrence timestamp ever associated with this
     * issue (an epoch-ms value derived from the underlying finding's
     * evidenceRefs, or the review's trace window as a fallback - see
     * developmentIssueBridge.ts). Distinct from `lastDetectedAt`, which only
     * tracks when this row was last *processed* by recordIssue() and can
     * therefore tick forward even when a review merely re-cites the exact
     * same historical evidence it cited before. A canary rollback decision
     * must compare against this field, never against `lastDetectedAt`
     * alone, so replaying old evidence after a deploy never looks like a
     * fresh post-deploy recurrence.
     */
    lastEvidenceAt: number | null;
}

interface IssueRow {
    id: string;
    fingerprint: string;
    status: string;
    owner_layer: string;
    severity: string;
    category: string;
    title: string;
    description: string;
    evidence: string;
    deadline_at: number | null;
    attempts: number;
    resolution_evidence: string | null;
    related_workflow_id: string | null;
    related_review_id: string | null;
    recurrence_count: number;
    first_detected_at: number;
    last_detected_at: number;
    resolved_at: number | null;
    created_at: number;
    updated_at: number;
    next_retry_at: number | null;
    last_evidence_at: number | null;
}

function rowToRecord(row: IssueRow): IssueRecord {
    let evidence: string[];
    try {
        evidence = JSON.parse(row.evidence) as string[];
    } catch (error) {
        throw new RegistryError(`Issue '${row.id}' has corrupt evidence JSON: ${error}`, { cause: error });
    }
    return {
        id: row.id,
        fingerprint: row.fingerprint,
        status: row.status as IssueStatus,
        ownerLayer: row.owner_layer as IssueOwnerLayer,
        severity: row.severity as IssueSeverity,
        category: row.category as IssueCategory,
        title: row.title,
        description: row.description,
        evidence,
        deadlineAt: row.deadline_at,
        attempts: row.attempts,
        resolutionEvidence: row.resolution_evidence,
        relatedWorkflowId: row.related_workflow_id,
        relatedReviewId: row.related_review_id,
        recurrenceCount: row.recurrence_count,
        firstDetectedAt: row.first_detected_at,
        lastDetectedAt: row.last_detected_at,
        resolvedAt: row.resolved_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        nextRetryAt: row.next_retry_at,
        lastEvidenceAt: row.last_evidence_at,
    };
}

/**
 * A fingerprint is a stable identity for "the same underlying problem"
 * independent of timing/evidence wording, so repeated detections dedupe
 * instead of piling up duplicate rows. Callers should pass the smallest
 * set of semantically-stable fields (e.g. category + owner target + a
 * normalized title), never raw evidence strings (those change every run).
 */
export function computeFingerprint(parts: string[]): string {
    const normalized = parts.map(part => part.toLowerCase().replace(/\s+/g, ' ').trim()).join('|');
    return createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

export function severityDeadlineMs(severity: IssueSeverity, now = Date.now()): number {
    const windows: Record<IssueSeverity, number> = {
        critical: 15 * 60 * 1000,
        high: 60 * 60 * 1000,
        medium: 24 * 60 * 60 * 1000,
        low: 7 * 24 * 60 * 60 * 1000,
    };
    return now + windows[severity];
}

export interface RecordIssueInput {
    fingerprint: string;
    ownerLayer: IssueOwnerLayer;
    severity: IssueSeverity;
    category: IssueCategory;
    title: string;
    description: string;
    evidence: string[];
    deadlineAt?: number | null;
    relatedWorkflowId?: string | null;
    relatedReviewId?: string | null;
    /**
     * Epoch-ms timestamp of the actual underlying evidence this detection
     * is based on (e.g. derived from a trace event referenced in
     * evidenceRefs), distinct from "now" (when recordIssue() happens to run).
     * When omitted/null, `lastEvidenceAt` is left at whatever it already
     * was (or null for a brand-new issue) - callers that never have a
     * meaningful evidence timestamp simply never advance it, rather than
     * having it default to the current time and silently defeat its
     * purpose.
     */
    evidenceAt?: number | null;
}

function maxNullable(a: number | null, b: number | null): number | null {
    if (a === null) return b;
    if (b === null) return a;
    return Math.max(a, b);
}

/**
 * Detect (or re-detect) an issue. Dedupes on fingerprint:
 * - unseen fingerprint -> new row, status='detected'.
 * - fingerprint currently open -> evidence merged, last_detected_at bumped,
 *   status/attempts/owner_layer untouched (still the same ongoing issue),
 *   and last_evidence_at only advances if this detection's evidenceAt is
 *   genuinely newer than what was already recorded.
 * - fingerprint previously resolved/rejected/deferred/failed -> reopened
 *   (status reset to 'detected', recurrenceCount incremented, resolution
 *   fields cleared, owner_layer restored to this call's ownerLayer, and
 *   last_evidence_at reset to this detection's own evidenceAt) because the
 *   same problem has recurred. Restoring owner_layer here matters
 *   specifically for a technical issue a `requires_direction` outcome had
 *   re-routed to owner_layer='human': once the same underlying problem is
 *   freshly (re)detected by the development pipeline, ownership must
 *   return to 'development' rather than staying stuck on a human forever.
 */
export function recordIssue(input: RecordIssueInput): IssueRecord {
    if (!input.fingerprint) throw new RegistryError('recordIssue requires a non-empty fingerprint');
    return withTransaction(database => {
        const now = Date.now();
        const existingRow = database
            .query('SELECT * FROM issues WHERE fingerprint = ?')
            .get(input.fingerprint) as IssueRow | null;

        if (!existingRow) {
            const id = newRegistryId('issue');
            const deadline = input.deadlineAt !== undefined ? input.deadlineAt : severityDeadlineMs(input.severity, now);
            database
                .query(
                    `INSERT INTO issues (
                        id, fingerprint, status, owner_layer, severity, category, title, description,
                        evidence, deadline_at, attempts, resolution_evidence, related_workflow_id,
                        related_review_id, recurrence_count, first_detected_at, last_detected_at,
                        resolved_at, created_at, updated_at, next_retry_at, last_evidence_at
                    ) VALUES (?, ?, 'detected', ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, 0, ?, ?, NULL, ?, ?, NULL, ?)`
                )
                .run(
                    id,
                    input.fingerprint,
                    input.ownerLayer,
                    input.severity,
                    input.category,
                    input.title,
                    input.description,
                    JSON.stringify(input.evidence.slice(-20)),
                    deadline,
                    input.relatedWorkflowId ?? null,
                    input.relatedReviewId ?? null,
                    now,
                    now,
                    now,
                    now,
                    input.evidenceAt ?? null
                );
            database
                .query(
                    'INSERT INTO issue_history (issue_id, from_status, to_status, note, at) VALUES (?, NULL, ?, ?, ?)'
                )
                .run(id, 'detected', 'issue detected', now);
            const row = database.query('SELECT * FROM issues WHERE id = ?').get(id) as IssueRow;
            return rowToRecord(row);
        }

        const existing = rowToRecord(existingRow);
        const mergedEvidence = [...existing.evidence, ...input.evidence].slice(-20);
        const reopening = TERMINAL_REOPENABLE_STATUSES.has(existing.status);
        const nextStatus: IssueStatus = reopening ? 'detected' : existing.status;
        const nextRecurrence = reopening ? existing.recurrenceCount + 1 : existing.recurrenceCount;
        const nextDeadline = reopening
            ? (input.deadlineAt !== undefined ? input.deadlineAt : severityDeadlineMs(input.severity, now))
            : existing.deadlineAt;
        const nextOwnerLayer = reopening ? input.ownerLayer : existing.ownerLayer;
        const candidateEvidenceAt = input.evidenceAt ?? null;
        const nextLastEvidenceAt = reopening ? candidateEvidenceAt : maxNullable(existing.lastEvidenceAt, candidateEvidenceAt);

        database
            .query(
                `UPDATE issues SET
                    status = ?, evidence = ?, last_detected_at = ?, recurrence_count = ?,
                    deadline_at = ?, resolved_at = ?, resolution_evidence = ?, updated_at = ?,
                    description = ?, next_retry_at = ?, owner_layer = ?, last_evidence_at = ?
                 WHERE id = ?`
            )
            .run(
                nextStatus,
                JSON.stringify(mergedEvidence),
                now,
                nextRecurrence,
                nextDeadline,
                reopening ? null : existing.resolvedAt,
                reopening ? null : existing.resolutionEvidence,
                now,
                input.description || existing.description,
                // Reopening clears any pending retry schedule - the issue is
                // freshly detected/recurred, not still waiting out a prior
                // failed attempt's backoff window.
                reopening ? null : existing.nextRetryAt,
                nextOwnerLayer,
                nextLastEvidenceAt,
                existing.id
            );
        if (reopening) {
            database
                .query(
                    'INSERT INTO issue_history (issue_id, from_status, to_status, note, at) VALUES (?, ?, ?, ?, ?)'
                )
                .run(existing.id, existing.status, 'detected', 'issue recurred and was reopened', now);
        }
        const row = database.query('SELECT * FROM issues WHERE id = ?').get(existing.id) as IssueRow;
        return rowToRecord(row);
    });
}

export interface TransitionIssueInput {
    id: string;
    status: IssueStatus;
    note?: string;
    resolutionEvidence?: string | null;
    relatedWorkflowId?: string | null;
    incrementAttempts?: boolean;
    /**
     * Only meaningful when transitioning to 'failed': schedules the bounded
     * autonomous retry/backoff deadline. Transitioning to any other status
     * clears it automatically (a resolved/canary/repairing/detected issue is
     * not "waiting to retry").
     */
    nextRetryAt?: number | null;
    /**
     * Re-routes ownership. Used sparingly: only an explicit
     * `requires_direction` outcome from the autonomous coding agent (missing
     * credentials/external authorization, or an irreversible product/policy
     * decision) may move a development-owned issue to ownerLayer='human'.
     * Technical failure/uncertainty must never use this field.
     */
    ownerLayer?: IssueOwnerLayer;
}

/** Explicit, transactional lifecycle transition (with audit history row). */
export function transitionIssue(input: TransitionIssueInput): IssueRecord {
    return withTransaction(database => {
        const row = database.query('SELECT * FROM issues WHERE id = ?').get(input.id) as IssueRow | null;
        if (!row) throw new RegistryError(`transitionIssue: no issue with id '${input.id}'`);
        const existing = rowToRecord(row);
        const now = Date.now();
        const resolvedTerminal = input.status === 'resolved' || input.status === 'rejected';
        const nextRetryAt =
            input.status !== 'failed'
                ? null
                : input.nextRetryAt !== undefined
                  ? input.nextRetryAt
                  : existing.nextRetryAt;
        database
            .query(
                `UPDATE issues SET
                    status = ?, attempts = ?, resolution_evidence = ?, related_workflow_id = ?,
                    resolved_at = ?, updated_at = ?, next_retry_at = ?, owner_layer = ?
                 WHERE id = ?`
            )
            .run(
                input.status,
                existing.attempts + (input.incrementAttempts ? 1 : 0),
                input.resolutionEvidence !== undefined ? input.resolutionEvidence : existing.resolutionEvidence,
                input.relatedWorkflowId !== undefined ? input.relatedWorkflowId : existing.relatedWorkflowId,
                resolvedTerminal ? now : existing.resolvedAt,
                now,
                nextRetryAt,
                input.ownerLayer ?? existing.ownerLayer,
                existing.id
            );
        database
            .query(
                'INSERT INTO issue_history (issue_id, from_status, to_status, note, at) VALUES (?, ?, ?, ?, ?)'
            )
            .run(existing.id, existing.status, input.status, input.note ?? null, now);
        const updated = database.query('SELECT * FROM issues WHERE id = ?').get(existing.id) as IssueRow;
        return rowToRecord(updated);
    });
}

export function getIssue(id: string): IssueRecord | null {
    const row = getRegistryDb().query('SELECT * FROM issues WHERE id = ?').get(id) as IssueRow | null;
    return row ? rowToRecord(row) : null;
}

export function getIssueByFingerprint(fingerprint: string): IssueRecord | null {
    const row = getRegistryDb().query('SELECT * FROM issues WHERE fingerprint = ?').get(fingerprint) as IssueRow | null;
    return row ? rowToRecord(row) : null;
}

export interface ListIssuesFilter {
    status?: IssueStatus;
    ownerLayer?: IssueOwnerLayer;
    category?: IssueCategory;
    openOnly?: boolean;
    limit?: number;
}

export function listIssues(filter: ListIssuesFilter = {}): IssueRecord[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (filter.status) {
        clauses.push('status = ?');
        params.push(filter.status);
    }
    if (filter.ownerLayer) {
        clauses.push('owner_layer = ?');
        params.push(filter.ownerLayer);
    }
    if (filter.category) {
        clauses.push('category = ?');
        params.push(filter.category);
    }
    if (filter.openOnly) {
        clauses.push(`status IN (${[...OPEN_STATUSES].map(() => '?').join(',')})`);
        params.push(...OPEN_STATUSES);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
    const rows = getRegistryDb()
        .query(`SELECT * FROM issues ${where} ORDER BY updated_at DESC LIMIT ?`)
        .all(...params, limit) as IssueRow[];
    return rows.map(rowToRecord);
}

/** Issues whose deadline has passed and are still open (for timeout handling). */
export function listOverdueIssues(now = Date.now()): IssueRecord[] {
    const rows = getRegistryDb()
        .query(
            `SELECT * FROM issues WHERE deadline_at IS NOT NULL AND deadline_at < ? AND status IN (${[...OPEN_STATUSES]
                .map(() => '?')
                .join(',')}) ORDER BY deadline_at ASC`
        )
        .all(now, ...OPEN_STATUSES) as IssueRow[];
    return rows.map(rowToRecord);
}

export function isOpenStatus(status: IssueStatus): boolean {
    return OPEN_STATUSES.has(status);
}

/**
 * Development-owned issues that failed a prior autonomous repair attempt
 * and whose bounded backoff window has elapsed - ready to be automatically
 * reopened and retried. Never returns human-owned issues: circuit-breaker
 * backoff is a retry policy, not a route to a human.
 */
export function listRetryReadyIssues(now = Date.now()): IssueRecord[] {
    const rows = getRegistryDb()
        .query(
            `SELECT * FROM issues
             WHERE status = 'failed' AND owner_layer = 'development'
               AND next_retry_at IS NOT NULL AND next_retry_at <= ?
             ORDER BY next_retry_at ASC`
        )
        .all(now) as IssueRow[];
    return rows.map(rowToRecord);
}
