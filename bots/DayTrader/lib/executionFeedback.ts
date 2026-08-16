// DayTrader - Execution Feedback
//
// Links a real execution outcome back to the issue/workflow/step/directive
// that produced it, so both the observer dashboard and the development
// reviewer's trace can see what deterministic execution actually did -
// not just what the model proposed. This is the evidentiary trail that
// backs issue resolution, workflow candidate promotion/rollback, and the
// "unresolved systemic issues" summary fed into development review traces.

import { getRegistryDb } from './registryDb';

export interface ExecutionFeedbackInput {
    issueId?: string | null;
    workflowId?: string | null;
    stepId?: string | null;
    directiveType?: string | null;
    outcome: string;
    evidence: string[];
}

export interface ExecutionFeedbackRecord {
    id: number;
    issueId: string | null;
    workflowId: string | null;
    stepId: string | null;
    directiveType: string | null;
    outcome: string;
    evidence: string[];
    at: number;
}

interface FeedbackRow {
    id: number;
    issue_id: string | null;
    workflow_id: string | null;
    step_id: string | null;
    directive_type: string | null;
    outcome: string;
    evidence: string;
    at: number;
}

function rowToRecord(row: FeedbackRow): ExecutionFeedbackRecord {
    let evidence: string[];
    try {
        evidence = JSON.parse(row.evidence) as string[];
    } catch {
        evidence = [];
    }
    return {
        id: row.id,
        issueId: row.issue_id,
        workflowId: row.workflow_id,
        stepId: row.step_id,
        directiveType: row.directive_type,
        outcome: row.outcome,
        evidence,
        at: row.at,
    };
}

export function recordExecutionFeedback(input: ExecutionFeedbackInput): ExecutionFeedbackRecord {
    const database = getRegistryDb();
    const now = Date.now();
    database
        .query(
            `INSERT INTO execution_feedback (issue_id, workflow_id, step_id, directive_type, outcome, evidence, at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            input.issueId ?? null,
            input.workflowId ?? null,
            input.stepId ?? null,
            input.directiveType ?? null,
            input.outcome,
            JSON.stringify(input.evidence.slice(-20)),
            now
        );
    const row = database
        .query('SELECT * FROM execution_feedback WHERE id = (SELECT last_insert_rowid())')
        .get() as FeedbackRow;
    return rowToRecord(row);
}

export interface ListExecutionFeedbackFilter {
    issueId?: string;
    workflowId?: string;
    sinceMs?: number;
    limit?: number;
}

export function listExecutionFeedback(filter: ListExecutionFeedbackFilter = {}): ExecutionFeedbackRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.issueId) {
        clauses.push('issue_id = ?');
        params.push(filter.issueId);
    }
    if (filter.workflowId) {
        clauses.push('workflow_id = ?');
        params.push(filter.workflowId);
    }
    if (filter.sinceMs !== undefined) {
        clauses.push('at >= ?');
        params.push(filter.sinceMs);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 2000));
    const rows = getRegistryDb()
        .query(`SELECT * FROM execution_feedback ${where} ORDER BY at DESC LIMIT ?`)
        .all(...params, limit) as FeedbackRow[];
    return rows.map(rowToRecord);
}
