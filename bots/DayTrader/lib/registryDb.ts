// DayTrader - Persistent Issue/Workflow/Maintenance Registry (SQLite)
//
// A single bun:sqlite database is the coordination point for every
// system-owned record that must survive across the multiple OS processes
// that make up DayTrader (main loop, development reviewer, maintenance
// worker, observer). JSON files (operator.json, development.json,
// workflows.json, ...) remain the source of truth for hot runtime state and
// existing consumers keep working unchanged; this registry is additive and
// only stores the new lifecycle-tracked record types (issues, workflow
// candidates, maintenance work, execution feedback).
//
// Coordination model:
// - WAL journal mode lets the main loop, development runner, maintenance
//   worker and observer read/write concurrently without corrupting a
//   single writer's transaction.
// - A generous busy_timeout makes concurrent writers block-and-retry
//   instead of failing with SQLITE_BUSY under normal contention.
// - All multi-statement mutations go through `withTransaction`, so a crash
//   mid-update can never leave a half-written lifecycle record behind.
//
// Error handling: corrupt databases or permission failures are never
// silently downgraded to "empty registry" - they throw a descriptive error
// so a human/operator finds out immediately instead of the system quietly
// losing issue history.

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DEFAULT_DB_PATH = join(DATA_DIR, 'registry.sqlite');

const SCHEMA_STATEMENTS: string[] = [
    `CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        owner_layer TEXT NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        evidence TEXT NOT NULL,
        deadline_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        resolution_evidence TEXT,
        related_workflow_id TEXT,
        related_review_id TEXT,
        recurrence_count INTEGER NOT NULL DEFAULT 0,
        first_detected_at INTEGER NOT NULL,
        last_detected_at INTEGER NOT NULL,
        resolved_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status)`,
    `CREATE INDEX IF NOT EXISTS idx_issues_owner_layer ON issues(owner_layer)`,
    `CREATE TABLE IF NOT EXISTS issue_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        note TEXT,
        at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_issue_history_issue ON issue_history(issue_id)`,
    `CREATE TABLE IF NOT EXISTS workflow_candidates (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        workflow TEXT NOT NULL,
        validation_notes TEXT NOT NULL,
        related_issue_id TEXT,
        related_review_id TEXT,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        promoted_workflow_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        decided_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_workflow_candidates_status ON workflow_candidates(status)`,
    `CREATE INDEX IF NOT EXISTS idx_workflow_candidates_hash ON workflow_candidates(hash)`,
    `CREATE TABLE IF NOT EXISTS maintenance_work (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        recipe_id TEXT NOT NULL,
        status TEXT NOT NULL,
        worktree_path TEXT,
        branch_name TEXT,
        commit_sha TEXT,
        patch_manifest TEXT,
        test_output TEXT,
        canary_outcome TEXT,
        rollback_reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_maintenance_work_status ON maintenance_work(status)`,
    `CREATE INDEX IF NOT EXISTS idx_maintenance_work_issue ON maintenance_work(issue_id)`,
    `CREATE TABLE IF NOT EXISTS execution_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id TEXT,
        workflow_id TEXT,
        step_id TEXT,
        directive_type TEXT,
        outcome TEXT NOT NULL,
        evidence TEXT NOT NULL,
        at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_execution_feedback_at ON execution_feedback(at)`,
    `CREATE INDEX IF NOT EXISTS idx_execution_feedback_issue ON execution_feedback(issue_id)`,
];

let db: Database | null = null;
let dbPath: string = DEFAULT_DB_PATH;

/**
 * Explicit registry error. Corrupt databases and permission failures are
 * never silently swallowed into an empty/default registry - callers (and
 * ultimately a human) must see exactly what went wrong.
 */
export class RegistryError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'RegistryError';
    }
}

function openDatabase(path: string): Database {
    try {
        mkdirSync(dirname(path), { recursive: true });
    } catch (error) {
        throw new RegistryError(`Cannot create registry data directory for '${path}': ${error}`, { cause: error });
    }
    let instance: Database;
    try {
        instance = new Database(path, { create: true });
    } catch (error) {
        throw new RegistryError(`Cannot open registry database '${path}': ${error}`, { cause: error });
    }
    try {
        instance.exec('PRAGMA journal_mode = WAL');
        instance.exec('PRAGMA busy_timeout = 5000');
        instance.exec('PRAGMA foreign_keys = ON');
        for (const statement of SCHEMA_STATEMENTS) instance.run(statement);
    } catch (error) {
        instance.close();
        throw new RegistryError(
            `Registry database '${path}' failed migration (corrupt file or permission failure): ${error}`,
            { cause: error }
        );
    }
    return instance;
}

/** Returns the shared registry database, opening/migrating it on first use. */
export function getRegistryDb(): Database {
    if (db) return db;
    if (!existsSync(dirname(dbPath))) {
        try {
            mkdirSync(dirname(dbPath), { recursive: true });
        } catch (error) {
            throw new RegistryError(`Cannot create registry data directory: ${error}`, { cause: error });
        }
    }
    db = openDatabase(dbPath);
    return db;
}

/**
 * Test-only hook: point the registry at an isolated database file (or
 * in-memory) and drop any cached connection. Never called from production
 * code paths.
 */
export function _resetRegistryForTests(path: string = ':memory:'): void {
    if (db) {
        db.close();
        db = null;
    }
    dbPath = path;
}

/** Runs `fn` inside a single SQLite transaction; rolls back on throw. */
export function withTransaction<T>(fn: (database: Database) => T): T {
    const database = getRegistryDb();
    const run = database.transaction(fn);
    try {
        return run(database) as T;
    } catch (error) {
        if (error instanceof RegistryError) throw error;
        throw new RegistryError(`Registry transaction failed: ${error}`, { cause: error });
    }
}

export function newRegistryId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
