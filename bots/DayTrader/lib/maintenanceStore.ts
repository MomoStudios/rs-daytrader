// DayTrader - Maintenance Work Lifecycle
//
// Tracks the lifecycle of an automated repository repair attempt:
// proposed -> queued -> running -> tested -> canary -> promoted
//                                          \-> rejected/rolled_back/failed
//
// Every row is linked to the issue it repairs and to the isolated worktree
// used to build/validate the patch. This is pure bookkeeping; the actual
// bounded command execution lives in isolatedWorkerRunner.ts.

import { getRegistryDb, newRegistryId, withTransaction, RegistryError } from './registryDb';

export type MaintenanceWorkStatus =
    | 'proposed'
    | 'queued'
    | 'running'
    | 'tested'
    | 'canary'
    | 'promoted'
    | 'rejected'
    | 'rolled_back'
    | 'failed';

export interface MaintenanceWorkRecord {
    id: string;
    issueId: string;
    recipeId: string;
    status: MaintenanceWorkStatus;
    worktreePath: string | null;
    branchName: string | null;
    commitSha: string | null;
    patchManifest: string | null;
    testOutput: string | null;
    canaryOutcome: string | null;
    rollbackReason: string | null;
    attempts: number;
    createdAt: number;
    updatedAt: number;
    completedAt: number | null;
}

interface MaintenanceRow {
    id: string;
    issue_id: string;
    recipe_id: string;
    status: string;
    worktree_path: string | null;
    branch_name: string | null;
    commit_sha: string | null;
    patch_manifest: string | null;
    test_output: string | null;
    canary_outcome: string | null;
    rollback_reason: string | null;
    attempts: number;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
}

function rowToRecord(row: MaintenanceRow): MaintenanceWorkRecord {
    return {
        id: row.id,
        issueId: row.issue_id,
        recipeId: row.recipe_id,
        status: row.status as MaintenanceWorkStatus,
        worktreePath: row.worktree_path,
        branchName: row.branch_name,
        commitSha: row.commit_sha,
        patchManifest: row.patch_manifest,
        testOutput: row.test_output,
        canaryOutcome: row.canary_outcome,
        rollbackReason: row.rollback_reason,
        attempts: row.attempts,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
    };
}

const TERMINAL_STATUSES = new Set<MaintenanceWorkStatus>(['promoted', 'rejected', 'rolled_back', 'failed']);

/** Propose (or reuse an existing open) maintenance work item for an issue+recipe pair. */
export function proposeMaintenanceWork(issueId: string, recipeId: string): MaintenanceWorkRecord {
    return withTransaction(database => {
        const existingRow = database
            .query(
                'SELECT * FROM maintenance_work WHERE issue_id = ? AND recipe_id = ? AND status NOT IN (?, ?, ?, ?) ORDER BY updated_at DESC LIMIT 1'
            )
            .get(issueId, recipeId, 'rejected', 'rolled_back', 'failed', 'promoted') as MaintenanceRow | null;
        if (existingRow) return rowToRecord(existingRow);

        const id = newRegistryId('maint');
        const now = Date.now();
        database
            .query(
                `INSERT INTO maintenance_work (
                    id, issue_id, recipe_id, status, worktree_path, branch_name, commit_sha,
                    patch_manifest, test_output, canary_outcome, rollback_reason, attempts,
                    created_at, updated_at, completed_at
                ) VALUES (?, ?, ?, 'proposed', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?, NULL)`
            )
            .run(id, issueId, recipeId, now, now);
        const row = database.query('SELECT * FROM maintenance_work WHERE id = ?').get(id) as MaintenanceRow;
        return rowToRecord(row);
    });
}

/**
 * Atomically claims a newly proposed work item. Only one worker can move a
 * row from proposed to queued; concurrent workers receive null and must not
 * touch the existing run.
 */
export function claimMaintenanceWork(id: string): MaintenanceWorkRecord | null {
    return withTransaction(database => {
        const now = Date.now();
        const result = database
            .query(
                `UPDATE maintenance_work
                 SET status = 'queued', attempts = attempts + 1, updated_at = ?
                 WHERE id = ? AND status = 'proposed'`
            )
            .run(now, id);
        if (result.changes === 0) return null;
        const row = database.query('SELECT * FROM maintenance_work WHERE id = ?').get(id) as MaintenanceRow;
        return rowToRecord(row);
    });
}

export interface TransitionMaintenanceWorkInput {
    id: string;
    status: MaintenanceWorkStatus;
    worktreePath?: string | null;
    branchName?: string | null;
    commitSha?: string | null;
    patchManifest?: string | null;
    testOutput?: string | null;
    canaryOutcome?: string | null;
    rollbackReason?: string | null;
    incrementAttempts?: boolean;
}

export function transitionMaintenanceWork(input: TransitionMaintenanceWorkInput): MaintenanceWorkRecord {
    return withTransaction(database => {
        const row = database.query('SELECT * FROM maintenance_work WHERE id = ?').get(input.id) as
            | MaintenanceRow
            | null;
        if (!row) throw new RegistryError(`transitionMaintenanceWork: no work item with id '${input.id}'`);
        const existing = rowToRecord(row);
        const now = Date.now();
        const completed = TERMINAL_STATUSES.has(input.status);
        database
            .query(
                `UPDATE maintenance_work SET
                    status = ?, worktree_path = ?, branch_name = ?, commit_sha = ?, patch_manifest = ?,
                    test_output = ?, canary_outcome = ?, rollback_reason = ?, attempts = ?, updated_at = ?,
                    completed_at = ?
                 WHERE id = ?`
            )
            .run(
                input.status,
                input.worktreePath !== undefined ? input.worktreePath : existing.worktreePath,
                input.branchName !== undefined ? input.branchName : existing.branchName,
                input.commitSha !== undefined ? input.commitSha : existing.commitSha,
                input.patchManifest !== undefined ? input.patchManifest : existing.patchManifest,
                input.testOutput !== undefined ? input.testOutput : existing.testOutput,
                input.canaryOutcome !== undefined ? input.canaryOutcome : existing.canaryOutcome,
                input.rollbackReason !== undefined ? input.rollbackReason : existing.rollbackReason,
                existing.attempts + (input.incrementAttempts ? 1 : 0),
                now,
                completed ? now : existing.completedAt,
                existing.id
            );
        const updated = database.query('SELECT * FROM maintenance_work WHERE id = ?').get(existing.id) as MaintenanceRow;
        return rowToRecord(updated);
    });
}

export function getMaintenanceWork(id: string): MaintenanceWorkRecord | null {
    const row = getRegistryDb().query('SELECT * FROM maintenance_work WHERE id = ?').get(id) as MaintenanceRow | null;
    return row ? rowToRecord(row) : null;
}

export interface ListMaintenanceWorkFilter {
    status?: MaintenanceWorkStatus;
    issueId?: string;
    limit?: number;
}

export function listMaintenanceWork(filter: ListMaintenanceWorkFilter = {}): MaintenanceWorkRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status) {
        clauses.push('status = ?');
        params.push(filter.status);
    }
    if (filter.issueId) {
        clauses.push('issue_id = ?');
        params.push(filter.issueId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
    const rows = getRegistryDb()
        .query(`SELECT * FROM maintenance_work ${where} ORDER BY updated_at DESC LIMIT ?`)
        .all(...params, limit) as MaintenanceRow[];
    return rows.map(rowToRecord);
}
