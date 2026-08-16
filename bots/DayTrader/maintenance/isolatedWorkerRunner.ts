// DayTrader - Isolated Maintenance Worker Runner
//
// Executes an approved repair recipe against a real issue inside an
// isolated git worktree. No LLM participates in this process at all: the
// recipe's commands and test command are a fixed, reviewed allowlist (see
// workerContract.ts), and every command is run as an exact argv (never a
// shell string) with a restricted environment (no credentials, no runtime
// bot data). Mandatory tests must pass before anything is committed, and
// the commit first reaches "canary". Only recipes explicitly marked for
// automatic promotion may then deploy, reverify, and resolve the issue.

import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
    buildRestrictedEnv,
    getApprovedRecipe,
    isCommandAllowed,
    isPathAllowed,
    resolveRecipeCommand,
} from './workerContract';
import type { IssueRecord } from '../lib/issueRegistry';
import { transitionIssue } from '../lib/issueRegistry';
import {
    claimMaintenanceWork,
    getMaintenanceWork,
    proposeMaintenanceWork,
    transitionMaintenanceWork,
    type MaintenanceWorkRecord,
} from '../lib/maintenanceStore';
import { log } from '../lib/logger';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname, '..', '..', '..');
const DEFAULT_WORKTREE_PARENT = join(__dirname, '..', 'data', 'maintenance-worktrees');

export interface RunCommandResult {
    argv: string[];
    success: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

export type SpawnFn = (
    argv: string[],
    opts: { cwd: string; env: Record<string, string>; timeoutMs: number }
) => Promise<RunCommandResult>;

/** Real process spawn, used unless a test injects a fake one. */
export const defaultSpawn: SpawnFn = async (argv, opts) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
        const first = argv[0];
        if (!first) throw new Error('empty command');
        const proc = Bun.spawn({
            cmd: argv,
            cwd: opts.cwd,
            env: opts.env,
            stdout: 'pipe',
            stderr: 'pipe',
            signal: controller.signal,
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        return { argv, success: exitCode === 0, exitCode, stdout, stderr };
    } catch (error) {
        return { argv, success: false, exitCode: null, stdout: '', stderr: String(error) };
    } finally {
        clearTimeout(timer);
    }
};

export interface RunMaintenanceWorkOptions {
    repoRoot?: string;
    worktreeParentDir?: string;
    spawn?: SpawnFn;
}

function env(isolatedHome?: string) {
    return buildRestrictedEnv(process.env, isolatedHome);
}

/**
 * Runs one approved recipe against one issue end-to-end: isolated
 * worktree -> allowlisted repair commands -> mandatory tests -> patch
 * manifest + commit -> canary. Promotion is handled separately so deployment
 * can revalidate the target checkout and recipe contract. Throws
 * (rather than silently proceeding) if the recipe is unknown, ineligible
 * for the issue's category, or its deterministic matcher rejects the
 * issue - an issue without an approved, matching recipe must stay
 * owned/deferred, never auto-repaired.
 */
export async function runMaintenanceWork(
    issue: IssueRecord,
    recipeId: string,
    options: RunMaintenanceWorkOptions = {}
): Promise<MaintenanceWorkRecord> {
    const recipe = getApprovedRecipe(recipeId);
    if (!recipe) throw new Error(`No approved maintenance recipe '${recipeId}'`);
    if (!recipe.eligibleCategories.includes(issue.category)) {
        throw new Error(`Recipe '${recipeId}' is not eligible for issue category '${issue.category}'`);
    }
    if (!recipe.matchesIssue(issue)) {
        throw new Error(
            `Recipe '${recipeId}' does not deterministically match issue '${issue.id}'; it must stay owned/deferred, not auto-repaired`
        );
    }

    const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
    const worktreeParentDir = options.worktreeParentDir ?? DEFAULT_WORKTREE_PARENT;
    const spawnFn = options.spawn ?? defaultSpawn;
    const isolatedHome = join(worktreeParentDir, '.home');
    mkdirSync(isolatedHome, { recursive: true });
    const restrictedEnv = env(isolatedHome);

    const proposed = proposeMaintenanceWork(issue.id, recipe.id);
    const claimed = claimMaintenanceWork(proposed.id);
    if (!claimed) {
        throw new Error(
            `Maintenance work '${proposed.id}' is already ${proposed.status}; another worker owns it`
        );
    }
    let work = claimed;
    transitionIssue({ id: issue.id, status: 'repairing', incrementAttempts: true });

    mkdirSync(worktreeParentDir, { recursive: true });
    const branchName = `maintenance/${recipe.id}-${work.id}`;
    const worktreePath = join(worktreeParentDir, work.id);

    const addWorktree = await spawnFn(['git', 'worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], {
        cwd: repoRoot,
        env: restrictedEnv,
        timeoutMs: 30_000,
    });
    if (!addWorktree.success) {
        return failWork(work.id, issue.id, `failed to create isolated worktree: ${addWorktree.stderr.slice(-1000)}`);
    }
    work = transitionMaintenanceWork({ id: work.id, status: 'running', worktreePath, branchName });

    try {
        for (const argv of recipe.commands) {
            if (!isCommandAllowed(recipe, argv)) {
                return await rollback(work.id, issue.id, branchName, repoRoot, spawnFn, `command not in allowlist: ${argv.join(' ')}`);
            }
            const result = await spawnFn(resolveRecipeCommand(argv), {
                cwd: worktreePath,
                env: restrictedEnv,
                timeoutMs: recipe.maxDurationMs,
            });
            if (!result.success) {
                return await rollback(
                    work.id,
                    issue.id,
                    branchName,
                    repoRoot,
                    spawnFn,
                    `repair command failed: ${argv.join(' ')}: ${result.stderr.slice(-1000)}`
                );
            }
        }

        const testResult = await spawnFn(resolveRecipeCommand(recipe.testCommand), {
            cwd: worktreePath,
            env: restrictedEnv,
            timeoutMs: recipe.maxDurationMs,
        });
        transitionMaintenanceWork({
            id: work.id,
            status: testResult.success ? 'tested' : 'failed',
            testOutput: `${testResult.stdout}\n${testResult.stderr}`.slice(-4000),
        });
        if (!testResult.success) {
            return await rollback(work.id, issue.id, branchName, repoRoot, spawnFn, 'mandatory tests failed');
        }

        const status = await spawnFn(['git', 'status', '--porcelain', '--untracked-files=no'], {
            cwd: worktreePath,
            env: restrictedEnv,
            timeoutMs: 15_000,
        });
        const changedPaths = status.stdout
            .split('\n')
            .map(line => line.slice(3).trim())
            .filter(Boolean);
        if (changedPaths.length === 0) {
            return await rollback(work.id, issue.id, branchName, repoRoot, spawnFn, 'recipe produced no changes');
        }
        for (const path of changedPaths) {
            if (!isPathAllowed(recipe, path)) {
                return await rollback(work.id, issue.id, branchName, repoRoot, spawnFn, `changed path outside allowlist: ${path}`);
            }
        }

        const diff = await spawnFn(['git', 'diff', '--stat', '--no-renames'], { cwd: worktreePath, env: restrictedEnv, timeoutMs: 15_000 });
        await spawnFn(['git', 'add', '-A'], { cwd: worktreePath, env: restrictedEnv, timeoutMs: 15_000 });
        const stagedPaths = await spawnFn(['git', 'diff', '--cached', '--no-renames', '--name-only'], {
            cwd: worktreePath,
            env: restrictedEnv,
            timeoutMs: 15_000,
        });
        if (
            !stagedPaths.success ||
            stagedPaths.stdout.split('\n').map(path => path.trim()).filter(Boolean)
                .some(path => !isPathAllowed(recipe, path))
        ) {
            return await rollback(
                work.id,
                issue.id,
                branchName,
                repoRoot,
                spawnFn,
                'staged changes include a path outside the recipe allowlist'
            );
        }
        const commit = await spawnFn(
            ['git', 'commit', '-m', `chore(maintenance): ${recipe.id} for issue ${issue.id}`],
            { cwd: worktreePath, env: restrictedEnv, timeoutMs: 15_000 }
        );
        if (!commit.success) {
            return await rollback(work.id, issue.id, branchName, repoRoot, spawnFn, `commit failed: ${commit.stderr.slice(-1000)}`);
        }
        const rev = await spawnFn(['git', 'rev-parse', 'HEAD'], { cwd: worktreePath, env: restrictedEnv, timeoutMs: 15_000 });
        const commitSha = rev.stdout.trim();

        const canary = transitionMaintenanceWork({
            id: work.id,
            status: 'canary',
            commitSha,
            patchManifest: diff.stdout.slice(-4000),
            canaryOutcome: recipe.autoPromote
                ? 'awaiting automatic deployment verification'
                : 'awaiting explicit promotion',
        });
        transitionIssue({ id: issue.id, status: 'canary' });
        log('maintenance_work', {
            workId: canary.id,
            issueId: issue.id,
            recipeId: recipe.id,
            status: canary.status,
            commitSha,
            branchName,
        });
        return canary;
    } finally {
        // The worktree is always removed; the branch/commit (if any)
        // survives so a human/automation can inspect or promote it later.
        await spawnFn(['git', 'worktree', 'remove', '--force', worktreePath], {
            cwd: repoRoot,
            env: restrictedEnv,
            timeoutMs: 15_000,
        }).catch(() => undefined);
    }
}

async function rollback(
    workId: string,
    issueId: string,
    branchName: string,
    repoRoot: string,
    spawnFn: SpawnFn,
    reason: string
): Promise<MaintenanceWorkRecord> {
    transitionMaintenanceWork({ id: workId, status: 'rolled_back', rollbackReason: reason });
    transitionIssue({ id: issueId, status: 'failed', resolutionEvidence: reason });
    await spawnFn(['git', 'branch', '-D', branchName], { cwd: repoRoot, env: env(), timeoutMs: 15_000 }).catch(() => undefined);
    log('maintenance_work', { workId, issueId, status: 'rolled_back', reason });
    const record = getMaintenanceWork(workId);
    if (!record) throw new Error(`maintenance work '${workId}' vanished after rollback`);
    return record;
}

function failWork(workId: string, issueId: string, reason: string): MaintenanceWorkRecord {
    transitionMaintenanceWork({ id: workId, status: 'failed', rollbackReason: reason });
    transitionIssue({ id: issueId, status: 'failed', resolutionEvidence: reason });
    log('maintenance_work', { workId, issueId, status: 'failed', reason });
    const record = getMaintenanceWork(workId);
    if (!record) throw new Error(`maintenance work '${workId}' vanished after failure`);
    return record;
}

/**
 * Explicit, separate promotion step: merges the canary branch's commit
 * into the resolution record and marks the issue resolved. This never
 * happens automatically inside runMaintenanceWork - a human or a
 * dedicated deterministic policy must call this once satisfied with the
 * canary outcome.
 */
export async function promoteMaintenanceWork(
    workId: string,
    resolutionEvidence: string,
    options: Pick<RunMaintenanceWorkOptions, 'repoRoot' | 'spawn'> = {}
): Promise<MaintenanceWorkRecord> {
    const work = getMaintenanceWork(workId);
    if (!work) throw new Error(`No maintenance work with id '${workId}'`);
    if (work.status !== 'canary') throw new Error(`Cannot promote maintenance work in status '${work.status}'`);
    if (!work.commitSha || !/^[0-9a-f]{40,64}$/i.test(work.commitSha)) {
        throw new Error(`Maintenance work '${workId}' has no valid canary commit`);
    }
    const recipe = getApprovedRecipe(work.recipeId);
    if (!recipe) throw new Error(`Maintenance work '${workId}' references unknown recipe '${work.recipeId}'`);

    const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
    const spawnFn = options.spawn ?? defaultSpawn;
    const isolatedHome = join(repoRoot, 'bots', 'DayTrader', 'data', 'maintenance-home');
    mkdirSync(isolatedHome, { recursive: true });
    const restrictedEnv = env(isolatedHome);
    const status = await spawnFn(['git', 'status', '--porcelain', '--untracked-files=no'], {
        cwd: repoRoot,
        env: restrictedEnv,
        timeoutMs: 15_000,
    });
    if (!status.success || status.stdout.trim()) {
        throw new Error(
            `Cannot promote maintenance work into a dirty or unreadable target checkout: ` +
            `exit=${status.exitCode} stdout=${JSON.stringify(status.stdout)} stderr=${JSON.stringify(status.stderr)}`
        );
    }
    const paths = await spawnFn(
        ['git', 'diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', work.commitSha],
        { cwd: repoRoot, env: restrictedEnv, timeoutMs: 15_000 }
    );
    if (!paths.success) throw new Error(`Cannot inspect canary commit '${work.commitSha}': ${paths.stderr}`);
    const changedPaths = paths.stdout.split('\n').map(path => path.trim()).filter(Boolean);
    if (changedPaths.length === 0 || changedPaths.some(path => !isPathAllowed(recipe, path))) {
        throw new Error(`Canary commit '${work.commitSha}' contains missing or disallowed paths`);
    }

    const alreadyApplied = await spawnFn(['git', 'merge-base', '--is-ancestor', work.commitSha, 'HEAD'], {
        cwd: repoRoot,
        env: restrictedEnv,
        timeoutMs: 15_000,
    });
    const deployedByPromotion = !alreadyApplied.success;
    if (deployedByPromotion) {
        const cherryPick = await spawnFn(['git', 'cherry-pick', work.commitSha], {
            cwd: repoRoot,
            env: restrictedEnv,
            timeoutMs: recipe.maxDurationMs,
        });
        if (!cherryPick.success) {
            await spawnFn(['git', 'cherry-pick', '--abort'], {
                cwd: repoRoot,
                env: restrictedEnv,
                timeoutMs: 15_000,
            });
            throw new Error(`Canary deployment failed: ${cherryPick.stderr.slice(-1000)}`);
        }
    }
    const verification = await spawnFn(resolveRecipeCommand(recipe.testCommand), {
        cwd: repoRoot,
        env: restrictedEnv,
        timeoutMs: recipe.maxDurationMs,
    });
    if (!verification.success) {
        if (deployedByPromotion) {
            const rollbackResult = await spawnFn(['git', 'revert', '--no-edit', 'HEAD'], {
                cwd: repoRoot,
                env: restrictedEnv,
                timeoutMs: recipe.maxDurationMs,
            });
            const reason =
                `Post-deployment verification failed and deployment rollback ` +
                `${rollbackResult.success ? 'succeeded' : `failed: ${rollbackResult.stderr.slice(-500)}`}`;
            transitionMaintenanceWork({ id: workId, status: 'rolled_back', rollbackReason: reason });
            transitionIssue({ id: work.issueId, status: 'failed', resolutionEvidence: reason });
        }
        throw new Error(`Post-deployment verification failed: ${verification.stderr.slice(-1000)}`);
    }
    const deployedRevision = await spawnFn(['git', 'rev-parse', 'HEAD'], {
        cwd: repoRoot,
        env: restrictedEnv,
        timeoutMs: 15_000,
    });
    if (!deployedRevision.success) throw new Error('Cannot read deployed revision after promotion');

    const promoted = transitionMaintenanceWork({ id: workId, status: 'promoted' });
    transitionIssue({
        id: work.issueId,
        status: 'resolved',
        resolutionEvidence: `${resolutionEvidence}; deployed revision ${deployedRevision.stdout.trim()}`,
        relatedWorkflowId: work.commitSha,
    });
    log('maintenance_work', { workId, issueId: work.issueId, status: 'promoted', commitSha: work.commitSha });
    return promoted;
}

/** Explicit rollback of a canary/promoted maintenance work item. */
export function rejectMaintenanceWork(workId: string, reason: string): MaintenanceWorkRecord {
    const work = getMaintenanceWork(workId);
    if (!work) throw new Error(`No maintenance work with id '${workId}'`);
    if (work.status === 'promoted') {
        throw new Error(`Cannot reject deployed maintenance work '${workId}'; use a verified deployment rollback`);
    }
    const rejected = transitionMaintenanceWork({ id: workId, status: 'rejected', rollbackReason: reason });
    transitionIssue({ id: work.issueId, status: 'deferred', resolutionEvidence: reason });
    return rejected;
}
