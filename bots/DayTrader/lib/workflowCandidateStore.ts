// DayTrader - Workflow Candidate Lifecycle
//
// Reusable operator workflows must never be written straight into the
// production registry (workflows.json, read into every future planning
// prompt as `knownWorkflows`) just because an LLM proposed them - whether
// that LLM is the operator itself or the development reviewer. Every
// reusable workflow proposal becomes a tracked candidate that must pass
// static verification, then prove itself in canary executions, before it
// is promoted into the production registry. Failures roll a promoted
// workflow back out of production instead of leaving a bad workflow live.
//
// Lifecycle: proposed -> statically_verified -> canary -> promoted
//                                              \-> rejected
//                              (canary/promoted) -> rolled_back

import type { MaterialReservation } from './aiDecision';
import type { AssetMemory } from './assetMemory';
import { parseOperatorWorkflow, type OperatorWorkflow } from './operatorSchema';
import { reservationViolations } from './reservationPolicy';
import { getRegistryDb, withTransaction, RegistryError } from './registryDb';
import { removeReusableWorkflow, storeReusableWorkflow, workflowHash, type StoredWorkflow } from './workflowStore';

export type WorkflowCandidateSource = 'operator_plan' | 'operator_diagnosis' | 'development_review';
export type WorkflowCandidateStatus =
    | 'proposed'
    | 'statically_verified'
    | 'canary'
    | 'promoted'
    | 'rejected'
    | 'rolled_back';

export interface WorkflowCandidateRecord {
    id: string;
    hash: string;
    name: string;
    source: WorkflowCandidateSource;
    status: WorkflowCandidateStatus;
    workflow: OperatorWorkflow;
    validationNotes: string[];
    relatedIssueId: string | null;
    relatedReviewId: string | null;
    successCount: number;
    failureCount: number;
    promotedWorkflowId: string | null;
    createdAt: number;
    updatedAt: number;
    decidedAt: number | null;
}

interface CandidateRow {
    id: string;
    hash: string;
    name: string;
    source: string;
    status: string;
    workflow: string;
    validation_notes: string;
    related_issue_id: string | null;
    related_review_id: string | null;
    success_count: number;
    failure_count: number;
    promoted_workflow_id: string | null;
    created_at: number;
    updated_at: number;
    decided_at: number | null;
}

function rowToRecord(row: CandidateRow): WorkflowCandidateRecord {
    let workflow: OperatorWorkflow;
    let validationNotes: string[];
    try {
        workflow = JSON.parse(row.workflow) as OperatorWorkflow;
        validationNotes = JSON.parse(row.validation_notes) as string[];
    } catch (error) {
        throw new RegistryError(`Workflow candidate '${row.id}' has corrupt stored JSON: ${error}`, { cause: error });
    }
    return {
        id: row.id,
        hash: row.hash,
        name: row.name,
        source: row.source as WorkflowCandidateSource,
        status: row.status as WorkflowCandidateStatus,
        workflow,
        validationNotes,
        relatedIssueId: row.related_issue_id,
        relatedReviewId: row.related_review_id,
        successCount: row.success_count,
        failureCount: row.failure_count,
        promotedWorkflowId: row.promoted_workflow_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        decidedAt: row.decided_at,
    };
}

/**
 * Structural + policy verification independent of whichever code path
 * built the workflow. Re-parses the workflow (schema, bounded step count,
 * duplicate step ids, directive/completion enum validity all enforced by
 * parseOperatorWorkflow) and, when reservation context is supplied, checks
 * the workflow does not consume a materially-reserved resource.
 */
export function validateWorkflowCandidateStatically(
    workflow: OperatorWorkflow,
    reservations?: MaterialReservation[],
    assets?: AssetMemory
): { ok: boolean; notes: string[] } {
    const notes: string[] = [];
    try {
        const reparsed = parseOperatorWorkflow(JSON.parse(JSON.stringify(workflow)));
        if (!reparsed) {
            notes.push('workflow re-parsed to null');
            return { ok: false, notes };
        }
    } catch (error) {
        notes.push(`schema/hash re-validation failed: ${error}`);
        return { ok: false, notes };
    }
    for (const step of workflow.steps) {
        const completionType = step.completion.type;
        const narrowlyCompatible: Partial<Record<OperatorWorkflow['steps'][number]['directive']['type'], string[]>> = {
            walk_to: ['position', 'action_success'],
            dialog_continue: ['dialog_open', 'dialog_closed', 'action_success'],
            dialog_select: ['dialog_open', 'dialog_closed', 'action_success'],
            dismiss_blocking_ui: ['dialog_closed', 'interface_closed', 'action_success'],
            bank_open: ['interface_open', 'action_success'],
            shop_open: ['interface_open', 'action_success'],
            bank_close: ['interface_closed', 'action_success'],
            shop_close: ['interface_closed', 'action_success'],
            pickup: ['inventory', 'action_success'],
            bank_withdraw: ['inventory', 'action_success'],
            shop_buy: ['inventory', 'action_success'],
            set_combat_style: ['action_success'],
            wait: ['action_success'],
        };
        const allowed = narrowlyCompatible[step.directive.type];
        if (allowed && !allowed.includes(completionType)) {
            notes.push(
                `step '${step.id}' directive '${step.directive.type}' is incompatible with completion '${completionType}'`
            );
            return { ok: false, notes };
        }
    }
    if (reservations && assets) {
        const violations = reservationViolations(workflow, reservations, assets);
        if (violations.length > 0) {
            notes.push(...violations.map(v => `reservation violation: ${v}`));
            return { ok: false, notes };
        }
    }
    notes.push('schema, duplicate-id, and hash checks passed');
    return { ok: true, notes };
}

export interface ProposeWorkflowCandidateInput {
    workflow: OperatorWorkflow;
    source: WorkflowCandidateSource;
    relatedIssueId?: string | null;
    relatedReviewId?: string | null;
    materialReservations?: MaterialReservation[];
    assetMemory?: AssetMemory;
}

/**
 * Propose a reusable workflow as a candidate. Dedupes by content hash so
 * repeated proposals of literally the same workflow (a common outcome when
 * the same stall recurs) reuse one candidate row instead of accumulating
 * duplicates - this is the "hash integrity" identity check: the row id is
 * derived from the hash, so two rows can never silently diverge for what
 * should be the same candidate.
 */
export function proposeWorkflowCandidate(input: ProposeWorkflowCandidateInput): WorkflowCandidateRecord {
    const hash = workflowHash(input.workflow);
    const id = `candidate-${hash}`;
    return withTransaction(database => {
        const now = Date.now();
        const existingRow = database.query('SELECT * FROM workflow_candidates WHERE id = ?').get(id) as
            | CandidateRow
            | null;
        if (existingRow) {
            database
                .query('UPDATE workflow_candidates SET updated_at = ? WHERE id = ?')
                .run(now, id);
            const refreshed = database.query('SELECT * FROM workflow_candidates WHERE id = ?').get(id) as CandidateRow;
            return rowToRecord(refreshed);
        }

        const validation = validateWorkflowCandidateStatically(
            input.workflow,
            input.materialReservations,
            input.assetMemory
        );
        const status: WorkflowCandidateStatus = validation.ok ? 'statically_verified' : 'rejected';
        database
            .query(
                `INSERT INTO workflow_candidates (
                    id, hash, name, source, status, workflow, validation_notes, related_issue_id,
                    related_review_id, success_count, failure_count, promoted_workflow_id,
                    created_at, updated_at, decided_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?)`
            )
            .run(
                id,
                hash,
                input.workflow.name,
                input.source,
                status,
                JSON.stringify(input.workflow),
                JSON.stringify(validation.notes),
                input.relatedIssueId ?? null,
                input.relatedReviewId ?? null,
                now,
                now,
                status === 'rejected' ? now : null
            );
        const row = database.query('SELECT * FROM workflow_candidates WHERE id = ?').get(id) as CandidateRow;
        return rowToRecord(row);
    });
}

export function getWorkflowCandidate(id: string): WorkflowCandidateRecord | null {
    const row = getRegistryDb().query('SELECT * FROM workflow_candidates WHERE id = ?').get(id) as CandidateRow | null;
    return row ? rowToRecord(row) : null;
}

export function getWorkflowCandidateByHash(hash: string): WorkflowCandidateRecord | null {
    const row = getRegistryDb()
        .query('SELECT * FROM workflow_candidates WHERE hash = ? ORDER BY updated_at DESC LIMIT 1')
        .get(hash) as CandidateRow | null;
    return row ? rowToRecord(row) : null;
}

export interface ListWorkflowCandidatesFilter {
    status?: WorkflowCandidateStatus;
    source?: WorkflowCandidateSource;
    limit?: number;
}

export function listWorkflowCandidates(filter: ListWorkflowCandidatesFilter = {}): WorkflowCandidateRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status) {
        clauses.push('status = ?');
        params.push(filter.status);
    }

    if (filter.source) {
        clauses.push('source = ?');
        params.push(filter.source);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
    const rows = getRegistryDb()
        .query(`SELECT * FROM workflow_candidates ${where} ORDER BY updated_at DESC LIMIT ?`)
        .all(...params, limit) as CandidateRow[];
    return rows.map(rowToRecord);
}

/** Candidate workflows visible to the operator for real canary execution. */
export function listCanaryWorkflowOptions(limit = 10): StoredWorkflow[] {
    return listWorkflowCandidates({ limit: Math.max(1, Math.min(limit * 4, 100)) })
        .filter(
            candidate =>
                candidate.source === 'development_review' &&
                (candidate.status === 'statically_verified' || candidate.status === 'canary')
        )
        .slice(0, limit)
        .map(candidate => ({
            id: candidate.id,
            hash: candidate.hash,
            createdAt: candidate.createdAt,
            updatedAt: candidate.updatedAt,
            workflow: candidate.workflow,
        }));
}

const DEFAULT_CANARY_SUCCESS_THRESHOLD = 2;

/**
 * Record a real execution outcome for the reusable workflow with this
 * content hash (a full workflow completion = success; the workflow being
 * abandoned via repeated-failure diagnosis/escalation = failure). Drives
 * canary -> promoted (writes into the production registry only now) and
 * failure -> rejected/rolled_back. Returns null if no candidate exists for
 * this hash (e.g. a one-shot non-reusable workflow).
 */
export function recordWorkflowCandidateOutcome(
    hash: string,
    outcome: 'success' | 'failure',
    evidence?: string,
    canarySuccessThreshold = DEFAULT_CANARY_SUCCESS_THRESHOLD
): WorkflowCandidateRecord | null {
    return withTransaction(database => {
        const row = database
            .query('SELECT * FROM workflow_candidates WHERE hash = ? ORDER BY updated_at DESC LIMIT 1')
            .get(hash) as CandidateRow | null;
        if (!row) return null;
        const existing = rowToRecord(row);
        if (existing.status === 'rejected' || existing.status === 'rolled_back') return existing;

        const now = Date.now();
        const notes = evidence ? [...existing.validationNotes, evidence].slice(-30) : existing.validationNotes;

        if (outcome === 'failure') {
            const wasPromoted = existing.status === 'promoted';
            if (wasPromoted) removeReusableWorkflow(existing.promotedWorkflowId ?? existing.id);
            const nextStatus: WorkflowCandidateStatus = wasPromoted ? 'rolled_back' : 'rejected';
            database
                .query(
                    `UPDATE workflow_candidates SET status = ?, failure_count = failure_count + 1,
                        validation_notes = ?, updated_at = ?, decided_at = ? WHERE id = ?`
                )
                .run(nextStatus, JSON.stringify(notes), now, now, existing.id);
        } else {
            let nextStatus = existing.status;
            let promotedWorkflowId = existing.promotedWorkflowId;
            const nextSuccessCount = existing.successCount + 1;
            if (existing.status === 'statically_verified' || existing.status === 'canary') {
                if (nextSuccessCount >= canarySuccessThreshold) {
                    const stored = storeReusableWorkflow(existing.workflow);
                    if (stored) {
                        nextStatus = 'promoted';
                        promotedWorkflowId = stored.id;
                    }
                } else {
                    nextStatus = 'canary';
                }
            }
            database
                .query(
                    `UPDATE workflow_candidates SET status = ?, success_count = ?, validation_notes = ?,
                        promoted_workflow_id = ?, updated_at = ?, decided_at = ? WHERE id = ?`
                )
                .run(
                    nextStatus,
                    nextSuccessCount,
                    JSON.stringify(notes),
                    promotedWorkflowId,
                    now,
                    nextStatus === 'promoted' ? now : existing.decidedAt,
                    existing.id
                );
        }
        const updated = database.query('SELECT * FROM workflow_candidates WHERE id = ?').get(existing.id) as CandidateRow;
        return rowToRecord(updated);
    });
}

export function rejectWorkflowCandidate(id: string, reason: string): WorkflowCandidateRecord {
    return withTransaction(database => {
        const row = database.query('SELECT * FROM workflow_candidates WHERE id = ?').get(id) as CandidateRow | null;
        if (!row) throw new RegistryError(`rejectWorkflowCandidate: no candidate with id '${id}'`);
        const existing = rowToRecord(row);
        const now = Date.now();
        const notes = [...existing.validationNotes, reason].slice(-30);
        database
            .query(
                'UPDATE workflow_candidates SET status = ?, validation_notes = ?, updated_at = ?, decided_at = ? WHERE id = ?'
            )
            .run('rejected', JSON.stringify(notes), now, now, id);
        const updated = database.query('SELECT * FROM workflow_candidates WHERE id = ?').get(id) as CandidateRow;
        return rowToRecord(updated);
    });
}

export function rollbackWorkflowCandidate(id: string, reason: string): WorkflowCandidateRecord {
    return withTransaction(database => {
        const row = database.query('SELECT * FROM workflow_candidates WHERE id = ?').get(id) as CandidateRow | null;
        if (!row) throw new RegistryError(`rollbackWorkflowCandidate: no candidate with id '${id}'`);
        const existing = rowToRecord(row);
        if (existing.status === 'promoted' && existing.promotedWorkflowId) {
            removeReusableWorkflow(existing.promotedWorkflowId);
        }
        const now = Date.now();
        const notes = [...existing.validationNotes, reason].slice(-30);
        database
            .query(
                'UPDATE workflow_candidates SET status = ?, validation_notes = ?, updated_at = ?, decided_at = ? WHERE id = ?'
            )
            .run('rolled_back', JSON.stringify(notes), now, now, id);
        const updated = database.query('SELECT * FROM workflow_candidates WHERE id = ?').get(id) as CandidateRow;
        return rowToRecord(updated);
    });
}
