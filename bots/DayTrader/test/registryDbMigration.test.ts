import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { _resetRegistryForTests, getRegistryDb } from '../lib/registryDb';
import { computeFingerprint, listRetryReadyIssues, recordIssue, transitionIssue } from '../lib/issueRegistry';

const DATA_DIR = join(import.meta.dir, '..', 'data');
let tempDir: string | null = null;

afterEach(() => {
    _resetRegistryForTests(':memory:');
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = null;
    }
});

describe('registry database - additive column migration', () => {
    test('opening a pre-existing database file without next_retry_at adds the column without data loss', () => {
        tempDir = mkdtempSync(join(DATA_DIR, 'registry-migration-'));
        const dbPath = join(tempDir, 'registry.sqlite');

        // Simulate an older database file created before next_retry_at existed:
        // the same issues table, minus that column.
        const legacy = new Database(dbPath, { create: true });
        legacy.exec(`CREATE TABLE issues (
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
        )`);
        const now = Date.now();
        legacy
            .query(
                `INSERT INTO issues (
                    id, fingerprint, status, owner_layer, severity, category, title, description,
                    evidence, deadline_at, attempts, resolution_evidence, related_workflow_id,
                    related_review_id, recurrence_count, first_detected_at, last_detected_at,
                    resolved_at, created_at, updated_at
                ) VALUES ('issue-legacy', 'fp-legacy', 'detected', 'development', 'medium', 'failure',
                    'Legacy issue predating next_retry_at', 'created before the migration existed', '[]',
                    NULL, 0, NULL, NULL, NULL, 0, ?, ?, NULL, ?, ?)`
            )
            .run(now, now, now, now);
        legacy.close();

        _resetRegistryForTests(dbPath);
        const db = getRegistryDb(); // opening triggers the additive migration
        const columns = db.query('PRAGMA table_info(issues)').all() as Array<{ name: string }>;
        expect(columns.some(column => column.name === 'next_retry_at')).toBe(true);

        // The pre-existing row survived the migration untouched (retry is
        // simply unset, not data loss).
        const legacyRow = db.query('SELECT * FROM issues WHERE id = ?').get('issue-legacy') as { next_retry_at: number | null } | null;
        expect(legacyRow).not.toBeNull();
        expect(legacyRow?.next_retry_at ?? null).toBeNull();

        // The registry is fully usable afterward, including the new column.
        const created = recordIssue({
            fingerprint: computeFingerprint(['post-migration-issue']),
            ownerLayer: 'development',
            severity: 'low',
            category: 'failure',
            title: 'Created after migration',
            description: 'sanity check',
            evidence: [],
        });
        transitionIssue({ id: created.id, status: 'failed', nextRetryAt: now - 1000 });
        expect(listRetryReadyIssues().map(issue => issue.id)).toContain(created.id);
    });
});

describe('registry database - additive column migration (last_evidence_at)', () => {
    test('opening a pre-existing database file without last_evidence_at adds the column without data loss', () => {
        tempDir = mkdtempSync(join(DATA_DIR, 'registry-migration-evidence-'));
        const dbPath = join(tempDir, 'registry.sqlite');

        // Simulate a database file created before last_evidence_at existed
        // (but after next_retry_at was added).
        const legacy = new Database(dbPath, { create: true });
        legacy.exec(`CREATE TABLE issues (
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
            updated_at INTEGER NOT NULL,
            next_retry_at INTEGER
        )`);
        const now = Date.now();
        legacy
            .query(
                `INSERT INTO issues (
                    id, fingerprint, status, owner_layer, severity, category, title, description,
                    evidence, deadline_at, attempts, resolution_evidence, related_workflow_id,
                    related_review_id, recurrence_count, first_detected_at, last_detected_at,
                    resolved_at, created_at, updated_at, next_retry_at
                ) VALUES ('issue-legacy-2', 'fp-legacy-2', 'detected', 'development', 'medium', 'failure',
                    'Legacy issue predating last_evidence_at', 'created before the migration existed', '[]',
                    NULL, 0, NULL, NULL, NULL, 0, ?, ?, NULL, ?, ?, NULL)`
            )
            .run(now, now, now, now);
        legacy.close();

        _resetRegistryForTests(dbPath);
        const db = getRegistryDb(); // opening triggers the additive migration
        const columns = db.query('PRAGMA table_info(issues)').all() as Array<{ name: string }>;
        expect(columns.some(column => column.name === 'last_evidence_at')).toBe(true);

        // The pre-existing row survived the migration untouched.
        const legacyRow = db.query('SELECT * FROM issues WHERE id = ?').get('issue-legacy-2') as
            | { last_evidence_at: number | null }
            | null;
        expect(legacyRow).not.toBeNull();
        expect(legacyRow?.last_evidence_at ?? null).toBeNull();

        // The registry is fully usable afterward, including the new column.
        const created = recordIssue({
            fingerprint: computeFingerprint(['post-evidence-migration-issue']),
            ownerLayer: 'development',
            severity: 'low',
            category: 'failure',
            title: 'Created after migration',
            description: 'sanity check',
            evidence: [],
            evidenceAt: now,
        });
        expect(created.lastEvidenceAt).toBe(now);
    });
});
