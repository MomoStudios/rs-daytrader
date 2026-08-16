import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { _resetRegistryForTests } from '../lib/registryDb';
import { _setLogDataDirForTests } from '../lib/logger';
import { recordIssue, getIssue, type IssueRecord } from '../lib/issueRegistry';
import { listMaintenanceWork } from '../lib/maintenanceStore';
import {
    defaultSpawn,
    promoteMaintenanceWork,
    rejectMaintenanceWork,
    runMaintenanceWork,
} from '../maintenance/isolatedWorkerRunner';

const DATA_DIR = join(import.meta.dir, '..', 'data');
let repoRoot: string;
let worktreeParentDir: string;

// A tiny real git repository standing in for the production repo, so the
// worker exercises real `git worktree` / commit / diff mechanics without
// touching this checkout. The fixture `sdk/generate-api-docs.ts` mimics the
// real script: writes a fixed doc, and `--check` verifies it matches.
function initScratchRepo(): void {
    repoRoot = mkdtempSync(join(DATA_DIR, 'maint-repo-'));
    worktreeParentDir = join(repoRoot, '.worktrees');
    run(['git', 'init', '-q']);
    run(['git', 'config', 'user.email', 'bot@example.com']);
    run(['git', 'config', 'user.name', 'DayTrader Bot']);
    mkdirSync(join(repoRoot, 'sdk'), { recursive: true });
    writeFileSync(
        join(repoRoot, 'sdk', 'generate-api-docs.ts'),
        [
            "const target = 'sdk/API.md';",
            "const content = '# Generated API Docs\\n\\nok\\n';",
            "if (process.argv.includes('--check')) {",
            "  const fs = require('fs');",
            "  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';",
            '  if (current !== content) { console.error("drift"); process.exit(1); }',
            '  process.exit(0);',
            '} else {',
            "  require('fs').writeFileSync(target, content);",
            '}',
        ].join('\n')
    );
    writeFileSync(join(repoRoot, 'sdk', 'API.md'), '# Stale docs\n');
    run(['git', 'add', '-A']);
    run(['git', 'commit', '-q', '-m', 'initial scratch repo state']);
}

function run(argv: string[]): void {
    const result = Bun.spawnSync({ cmd: argv, cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) {
        throw new Error(`fixture command failed: ${argv.join(' ')}: ${result.stderr?.toString() ?? ''}`);
    }
}

function systemicIssue(): IssueRecord {
    return recordIssue({
        fingerprint: 'sdk-api-md-drift',
        ownerLayer: 'development',
        severity: 'low',
        category: 'systemic_code',
        title: 'sdk/API.md has drifted from source doc comments',
        description: 'generate-api-docs.ts --check reports drift in sdk/API.md',
        evidence: ['generate-api-docs.ts --check exited 1'],
    });
}

beforeEach(() => {
    _resetRegistryForTests(':memory:');
    initScratchRepo();
    _setLogDataDirForTests(repoRoot);
});

afterEach(() => {
    _resetRegistryForTests(':memory:');
    rmSync(repoRoot, { recursive: true, force: true });
});

describe('isolated worker runner - end to end (real git, fixture recipe target)', () => {
    test('runs the approved recipe in an isolated worktree, passes tests, and reaches canary', async () => {
        const issue = systemicIssue();
        const work = await runMaintenanceWork(issue, 'regenerate-api-docs', { repoRoot, worktreeParentDir, spawn: defaultSpawn });

        expect(work.status).toBe('canary');
        expect(work.commitSha).toBeTruthy();
        expect(work.patchManifest).toContain('API.md');

        // The isolated worktree must be cleaned up afterward...
        const worktrees = Bun.spawnSync({ cmd: ['git', 'worktree', 'list'], cwd: repoRoot }).stdout.toString();
        expect(worktrees).not.toContain(work.worktreePath ?? '__missing__');

        // ...but the commit/branch must survive so it can be reviewed/promoted.
        const branchList = Bun.spawnSync({ cmd: ['git', 'branch', '--list', work.branchName ?? ''], cwd: repoRoot }).stdout.toString();
        expect(branchList).toContain(work.branchName);

        // The main checkout is untouched - the stale doc is still stale on HEAD.
        expect(readFileSync(join(repoRoot, 'sdk', 'API.md'), 'utf8')).toBe('# Stale docs\n');

        const issueAfter = getIssue(issue.id);
        expect(issueAfter?.status).toBe('canary');
        expect(issueAfter?.attempts).toBe(1);
    }, 30_000);

    test('promoting a canary work item resolves the underlying issue', async () => {
        const issue = systemicIssue();
        const work = await runMaintenanceWork(issue, 'regenerate-api-docs', { repoRoot, worktreeParentDir, spawn: defaultSpawn });
        const promoted = await promoteMaintenanceWork(
            work.id,
            'reviewed diff manually, docs regenerated correctly',
            { repoRoot, spawn: defaultSpawn }
        );
        expect(promoted.status).toBe('promoted');
        expect(getIssue(issue.id)?.status).toBe('resolved');
        expect(readFileSync(join(repoRoot, 'sdk', 'API.md'), 'utf8')).toContain('Generated API Docs');
    }, 30_000);

    test('rejecting a canary work item defers the issue instead of leaving it falsely resolved', async () => {
        const issue = systemicIssue();
        const work = await runMaintenanceWork(issue, 'regenerate-api-docs', { repoRoot, worktreeParentDir, spawn: defaultSpawn });
        const rejected = rejectMaintenanceWork(work.id, 'diff touched more than expected, needs human review');
        expect(rejected.status).toBe('rejected');
        expect(getIssue(issue.id)?.status).toBe('deferred');
    }, 30_000);

    test('refuses to run an unapproved recipe id', async () => {
        await expect(runMaintenanceWork(systemicIssue(), 'delete-everything', { repoRoot, worktreeParentDir })).rejects.toThrow();
    });

    test('refuses to relabel deployed work as rejected without a verified rollback', async () => {
        const issue = systemicIssue();
        const work = await runMaintenanceWork(issue, 'regenerate-api-docs', { repoRoot, worktreeParentDir, spawn: defaultSpawn });
        await promoteMaintenanceWork(work.id, 'deployed', { repoRoot, spawn: defaultSpawn });
        expect(() => rejectMaintenanceWork(work.id, 'changed our mind')).toThrow('verified deployment rollback');
    }, 30_000);

    test('refuses to run when the deterministic matcher rejects the issue (owned/deferred, not auto-repaired)', async () => {
        const unrelated = recordIssue({
            fingerprint: 'unrelated-issue',
            ownerLayer: 'development',
            severity: 'low',
            category: 'systemic_code',
            title: 'Completely unrelated systemic code issue',
            description: 'nothing to do with API docs',
            evidence: [],
        });
        await expect(
            runMaintenanceWork(unrelated, 'regenerate-api-docs', { repoRoot, worktreeParentDir })
        ).rejects.toThrow();
        expect(listMaintenanceWork({ issueId: unrelated.id }).length).toBe(0);
    });

    test('refuses to run a recipe against an ineligible issue category', async () => {
        const wrongCategory = recordIssue({
            fingerprint: 'wrong-category-api-md',
            ownerLayer: 'operator',
            severity: 'low',
            category: 'failure',
            title: 'sdk/API.md mentioned here but wrong category',
            description: 'api.md',
            evidence: [],
        });
        await expect(
            runMaintenanceWork(wrongCategory, 'regenerate-api-docs', { repoRoot, worktreeParentDir })
        ).rejects.toThrow();
    });
});
