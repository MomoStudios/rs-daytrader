// DayTrader - Autonomous Deployment, Canary Evaluation, and Rollback
//
// A canary maintenance_work row created by autonomousWorkerRunner.ts has a
// real commit on an isolated branch, but nothing has reached the live
// checkout yet. This module is the only thing that ever touches the live
// checkout for autonomous repairs:
//
// 1. deployAutonomousMaintenanceWork - re-validates the commit's paths and
//    the target checkout's cleanliness, cherry-picks the commit into the
//    live checkout, re-runs the pinned full gate, and (only on success)
//    records a structured canary outcome with a bounded observation
//    deadline. The issue is deliberately left in 'canary' status -
//    deployment success is not resolution. A post-cherry-pick gate failure
//    only ever reverts the exact revision *this call* deployed - if the
//    commit was already an ancestor of HEAD before this call ran, it fails
//    for a bounded retry without touching the live checkout at all, rather
//    than blindly reverting a possibly-unrelated HEAD.
// 2. evaluateAutonomousCanaries - called every maintenance scan. Rolls back
//    immediately if the same issue is redetected (preferring a genuine
//    evidence-occurrence timestamp over mere reprocessing time - see
//    issueRegistry.ts's lastEvidenceAt) or system health/error metrics
//    materially regress after deployment; otherwise waits out the
//    observation window (extending it boundedly, never asking a human, if
//    telemetry is inconclusive) and promotes/resolves only once a fresh
//    post-deploy heartbeat actually confirms the system is alive with no
//    recurrence - a deploy that never earns one is rolled back once bounded
//    extensions are exhausted, never silently promoted.
// 3. rollbackAutonomousDeployment - `git revert --no-edit` on the clean
//    live checkout, re-verified by the pinned full gate, with a deployment
//    reload signal so every running process picks up the reverted code.

import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getIssue, transitionIssue, type IssueRecord } from '../lib/issueRegistry';
import {
    getMaintenanceWork,
    listMaintenanceWork,
    transitionMaintenanceWork,
    type MaintenanceWorkRecord,
} from '../lib/maintenanceStore';
import { buildRestrictedEnv } from './workerContract';
import { defaultSpawn, type SpawnFn } from './isolatedWorkerRunner';
import { AUTONOMOUS_RECIPE_ID, isDeployPathAllowed } from './autonomousWorkerRunner';
import { computeRegistryMetrics, type RegistryMetrics } from '../lib/registryMetrics';
import { readRuntimeHeartbeat, type RuntimeHeartbeat } from '../lib/runtimeHealth';
import { requestDeploymentReload } from '../lib/deploymentReload';
import { computeNextRetryAt } from './autonomousRetryPolicy';
import { resolvePinnedGateSteps, runPinnedGate } from './pinnedGate';
import { defaultSandboxSpawnFactory, type SandboxSpawnFactory } from './bwrapSandbox';
import { log } from '../lib/logger';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname, '..', '..', '..');

export const DEFAULT_OBSERVATION_WINDOW_MS = 15 * 60_000;
export const DEFAULT_EXTENSION_WINDOW_MS = 5 * 60_000;
export const DEFAULT_MAX_EXTENSIONS = 3;
const DEFAULT_GATE_TIMEOUT_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Canary outcome shape (persisted as JSON in maintenance_work.canary_outcome)
// ---------------------------------------------------------------------------

export interface RegistryMetricsSnapshot {
    openIssues: number;
    overdueIssues: number;
}

export interface AutonomousCanaryOutcome {
    originalCommit: string;
    changedPaths: string[];
    baselineLastDetectedAt: number;
    /**
     * The issue's lastEvidenceAt at the moment this canary was deployed, if
     * any was ever recorded. The preferred, precise post-deploy-recurrence
     * signal (see {@link wasIssueRedetectedAfterDeployment}): a review that
     * merely re-emits the exact same historical evidence it already cited
     * before this deploy never advances lastEvidenceAt, so it is never
     * mistaken for a fresh recurrence. Null when the issue predates evidence
     * occurrence tracking or no producer ever supplied an evidenceAt.
     */
    baselineLastEvidenceAt: number | null;
    baselineRecurrenceCount: number;
    baselineRegistryMetrics: RegistryMetricsSnapshot;
    deployedAt: number | null;
    deployedRevision: string | null;
    /** Exact commit whose inverse must be applied on rollback. */
    rollbackRevision: string | null;
    observationDeadlineAt: number | null;
    extensions: number;
    /**
     * The deployment-reload generation `requestDeploymentReload` returned
     * when this deploy landed (see lib/deploymentReload.ts). A main-loop
     * heartbeat only ever counts as proof this deploy actually took effect
     * once its own captured `deploymentGeneration` is `>=` this value - the
     * old process, still running on the pre-deploy generation it captured
     * at its own startup, can never satisfy that no matter how many
     * heartbeats it keeps writing before it notices the reload request and
     * exits.
     */
    requiredReloadGeneration: number;
    /**
     * The main-loop's OS pid observed immediately before this deploy, or
     * null if no heartbeat had ever been recorded yet. A second,
     * belt-and-suspenders confirmation alongside `requiredReloadGeneration`
     * that promotion is looking at a genuinely different (restarted)
     * process, not the same one that was already running before the
     * deploy - never blocking on its own when no baseline pid was ever
     * observed (null), since `requiredReloadGeneration` alone is already
     * sufficient in that case.
     */
    baselineMainLoopPid: number | null;
}

export function captureRegistryMetricsSnapshot(metrics: RegistryMetrics): RegistryMetricsSnapshot {
    return { openIssues: metrics.issues.open, overdueIssues: metrics.issues.overdueCount };
}

export function parseCanaryOutcome(value: string | null): AutonomousCanaryOutcome | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as Partial<AutonomousCanaryOutcome>;
        if (typeof parsed.originalCommit !== 'string') return null;
        return {
            originalCommit: parsed.originalCommit,
            changedPaths: Array.isArray(parsed.changedPaths) ? parsed.changedPaths : [],
            baselineLastDetectedAt: parsed.baselineLastDetectedAt ?? 0,
            baselineLastEvidenceAt: parsed.baselineLastEvidenceAt ?? null,
            baselineRecurrenceCount: parsed.baselineRecurrenceCount ?? 0,
            baselineRegistryMetrics: parsed.baselineRegistryMetrics ?? { openIssues: 0, overdueIssues: 0 },
            deployedAt: parsed.deployedAt ?? null,
            deployedRevision: parsed.deployedRevision ?? null,
            rollbackRevision: parsed.rollbackRevision ?? parsed.deployedRevision ?? null,
            observationDeadlineAt: parsed.observationDeadlineAt ?? null,
            extensions: parsed.extensions ?? 0,
            // Backward-compatible migration: a canary outcome persisted
            // before `requiredReloadGeneration` existed never crashes this
            // parse, but must never silently become promotable either. No
            // real heartbeat's `deploymentGeneration` can ever be `>=
            // Infinity`, so evaluateCanary's freshness check can never be
            // satisfied for a legacy row missing this field - it is only
            // ever extended (bounded) or rolled back, never falsely
            // promoted.
            requiredReloadGeneration: typeof parsed.requiredReloadGeneration === 'number' ? parsed.requiredReloadGeneration : Infinity,
            baselineMainLoopPid: typeof parsed.baselineMainLoopPid === 'number' ? parsed.baselineMainLoopPid : null,
        };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Pure decision helpers
// ---------------------------------------------------------------------------

/**
 * An issue redetected after its fix was deployed is the clearest possible
 * "this didn't actually fix it" signal - but "redetected" must mean fresh
 * *evidence*, not merely that recordIssue() ran again. The preferred check
 * compares the issue's own lastEvidenceAt (the newest evidence-occurrence
 * timestamp it has ever cited) against the deploy time: a development
 * review that re-emits the exact same historical trace evidence it already
 * cited before this deploy never advances lastEvidenceAt, so it is never
 * mistaken for a post-deploy recurrence. Only when no evidence-occurrence
 * timestamp is available at all (an issue predating this tracking, or a
 * producer that never supplies one) does this fall back to the coarser
 * last-detected-at-vs-baseline signal, which does measure mere record
 * processing time and is therefore a weaker guarantee.
 */
export function wasIssueRedetectedAfterDeployment(
    issue: Pick<IssueRecord, 'lastDetectedAt' | 'lastEvidenceAt'>,
    baseline: Pick<AutonomousCanaryOutcome, 'baselineLastDetectedAt' | 'baselineLastEvidenceAt' | 'deployedAt'>
): boolean {
    if (issue.lastEvidenceAt !== null && baseline.deployedAt !== null) {
        return issue.lastEvidenceAt > baseline.deployedAt;
    }
    return issue.lastDetectedAt > baseline.baselineLastDetectedAt;
}

/**
 * Conservative regression check: only flags a regression when *both* open
 * and overdue issue counts have measurably worsened, so a single unrelated
 * new issue elsewhere in the system never triggers an automatic rollback
 * of an otherwise-healthy deploy.
 */
export function hasMetricsRegressed(baseline: RegistryMetricsSnapshot, current: RegistryMetricsSnapshot): boolean {
    const openIncrease = current.openIssues - baseline.openIssues;
    const overdueIncrease = current.overdueIssues - baseline.overdueIssues;
    return openIncrease >= 2 && overdueIncrease >= 1;
}

export type CanaryEvaluationDecision =
    | { action: 'rollback'; reason: string }
    | { action: 'wait' }
    | { action: 'extend'; reason: string }
    | { action: 'promote'; reason: string };

export interface CanaryEvaluationInput {
    outcome: AutonomousCanaryOutcome;
    issue: Pick<IssueRecord, 'lastDetectedAt' | 'lastEvidenceAt'>;
    currentMetrics: RegistryMetricsSnapshot;
    now: number;
    /** The current main-loop heartbeat, or null if none is recorded. */
    mainLoopHeartbeat: RuntimeHeartbeat | null;
    maxExtensions?: number;
    extensionWindowMs?: number;
}

/**
 * Pure decision function for one deployed canary. Never returns a
 * "requires_direction"/human outcome - inconclusive telemetry extends the
 * observation window (bounded) rather than escalating to a person, and a
 * deploy that never earns a fresh post-deploy heartbeat is rolled back
 * (never silently promoted) once bounded extensions are exhausted.
 */
export function evaluateCanary(input: CanaryEvaluationInput): CanaryEvaluationDecision {
    const { outcome, issue, currentMetrics, now, mainLoopHeartbeat } = input;
    const maxExtensions = input.maxExtensions ?? DEFAULT_MAX_EXTENSIONS;

    if (wasIssueRedetectedAfterDeployment(issue, outcome)) {
        return { action: 'rollback', reason: 'the same issue was redetected after deployment' };
    }
    if (hasMetricsRegressed(outcome.baselineRegistryMetrics, currentMetrics)) {
        return { action: 'rollback', reason: 'system health/error metrics materially regressed after deployment' };
    }
    if (outcome.observationDeadlineAt !== null && now < outcome.observationDeadlineAt) {
        return { action: 'wait' };
    }
    // A heartbeat only proves this deploy actually took effect once it
    // carries a `deploymentGeneration` at least as new as the generation
    // this deploy requested (see requestDeploymentReload/
    // captureStartupGeneration in lib/deploymentReload.ts) - the old
    // process, still running the pre-deploy generation it captured at its
    // own startup, keeps writing "loop"/"stopping" heartbeats for a while
    // after the reload request lands and can never satisfy this, no matter
    // how recent its `at` timestamp is. The pid check is a secondary,
    // belt-and-suspenders confirmation: it never blocks promotion when no
    // baseline pid was ever observed (null), but rejects a heartbeat that
    // (erroneously) reports a fresh-enough generation while still carrying
    // the exact pid that was already running before the deploy.
    const freshHeartbeat =
        outcome.deployedAt !== null &&
        mainLoopHeartbeat !== null &&
        mainLoopHeartbeat.at > outcome.deployedAt &&
        mainLoopHeartbeat.deploymentGeneration >= outcome.requiredReloadGeneration &&
        (outcome.baselineMainLoopPid === null || mainLoopHeartbeat.pid !== outcome.baselineMainLoopPid);
    if (freshHeartbeat) {
        return { action: 'promote', reason: 'observation window elapsed with fresh heartbeats and no recurrence/regression' };
    }
    if (outcome.extensions < maxExtensions) {
        return { action: 'extend', reason: 'no fresh runtime heartbeat observed yet since deployment; extending boundedly rather than asking a human' };
    }
    // Bounded extensions are exhausted and the deploy has still never
    // earned a single fresh post-deploy heartbeat - the system may not
    // even be alive on the new code. Never promote an unconfirmed deploy:
    // roll it back (bounded, automatic retry follows) instead of trusting
    // silence.
    return {
        action: 'rollback',
        reason: 'observation window and bounded extensions exhausted without ever observing a fresh post-deploy heartbeat; rolling back rather than promoting an unconfirmed deploy',
    };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface AutonomousDeploymentOptions {
    repoRoot?: string;
    spawn?: SpawnFn;
    gateTimeoutMs?: number;
    observationWindowMs?: number;
    extensionWindowMs?: number;
    maxExtensions?: number;
    now?: () => number;
    /** Overrides the deployment-reload request file path (tests only; production uses the real data dir). */
    reloadPath?: string;
    /**
     * Builds the sandboxed spawn function the pinned verification gate
     * runs every command through (see bwrapSandbox.ts). Defaults to
     * `defaultSandboxSpawnFactory` (a real bubblewrap sandbox) in
     * production; ordinary tests inject `identitySandboxSpawnFactory`
     * instead so they never need a real `bwrap` binary - see
     * bwrapSandbox.test.ts for the one focused test that does.
     */
    sandboxSpawnFactory?: SandboxSpawnFactory;
}

function env(repoRoot: string, isolatedHomeSuffix: string): Record<string, string> {
    const isolatedHome = join(repoRoot, 'bots', 'DayTrader', 'data', isolatedHomeSuffix);
    mkdirSync(isolatedHome, { recursive: true });
    return buildRestrictedEnv(process.env, isolatedHome);
}

/**
 * Verifies one exact revision (`commitSha`) by checking it out into a
 * brand-new, disposable, detached git worktree under ignored runtime data
 * (never inside the tracked repository tree) and running the pinned full
 * verification gate (see pinnedGate.ts) there, sandboxed (see
 * bwrapSandbox.ts) - never directly against the live checkout at
 * `repoRoot`, even though `repoRoot` may itself already be sitting at (or
 * past) this exact revision by the time this runs. This is deliberate: a
 * changed test/source file must never execute with direct read/write
 * access to the live checkout, only inside a disposable, sandboxed copy of
 * it that gets torn down (in a `finally`) the instant verification
 * finishes, pass or fail.
 */
async function verifyRevisionInDisposableWorktree(
    spawnFn: SpawnFn,
    repoRoot: string,
    commitSha: string,
    envVars: Record<string, string>,
    timeoutMsPerStep: number,
    sandboxSpawnFactory: SandboxSpawnFactory
): Promise<{ success: boolean; stdout: string; stderr: string }> {
    const worktreeParent = join(repoRoot, 'bots', 'DayTrader', 'data', 'deploy-verify-worktrees');
    mkdirSync(worktreeParent, { recursive: true });
    const worktreePath = join(worktreeParent, `verify-${commitSha.slice(0, 12)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const add = await spawnFn(['git', 'worktree', 'add', '--detach', worktreePath, commitSha], {
        cwd: repoRoot,
        env: envVars,
        timeoutMs: 30_000,
    });
    if (!add.success) {
        return {
            success: false,
            stdout: '',
            stderr: `could not create a disposable verification worktree at revision '${commitSha}': ${add.stderr.slice(-1000)}`,
        };
    }
    try {
        const steps = resolvePinnedGateSteps(repoRoot, worktreePath);
        const sandboxedSpawn = sandboxSpawnFactory(spawnFn, {
            workspaceRealPath: worktreePath,
            toolNodeModulesRealPath: join(repoRoot, 'node_modules'),
            bunExecutableRealPath: process.execPath,
            additionalReadOnlyMounts: [
                {
                    realPath: join(repoRoot, 'server', 'webclient', 'node_modules'),
                    sandboxPath: '/workspace/server/webclient/node_modules',
                },
            ],
        });
        return await runPinnedGate(sandboxedSpawn, steps, worktreePath, envVars, timeoutMsPerStep);
    } finally {
        // Always cleaned up - pass or fail, this worktree never survives
        // past this single verification call.
        await spawnFn(['git', 'worktree', 'remove', '--force', worktreePath], {
            cwd: repoRoot,
            env: envVars,
            timeoutMs: 15_000,
        }).catch(() => undefined);
    }
}

/**
 * Deploys a canary maintenance work item's commit into the live checkout.
 * Requires the target checkout to be clean; re-validates every changed path
 * against the same broad repository policy the worker used, cherry-picks,
 * re-runs the mandatory full gate (against a disposable, sandboxed
 * worktree at the exact deployed revision - never the live checkout
 * itself), and only then records the canary baseline/observation
 * deadline. Never marks the issue resolved.
 */
export async function deployAutonomousMaintenanceWork(
    workId: string,
    options: AutonomousDeploymentOptions = {}
): Promise<MaintenanceWorkRecord> {
    const work = getMaintenanceWork(workId);
    if (!work) throw new Error(`No maintenance work with id '${workId}'`);
    if (work.recipeId !== AUTONOMOUS_RECIPE_ID) {
        throw new Error(`Maintenance work '${workId}' is not an autonomous-development repair`);
    }
    if (work.status !== 'canary') throw new Error(`Cannot deploy maintenance work in status '${work.status}'`);
    if (!work.commitSha || !/^[0-9a-f]{40,64}$/i.test(work.commitSha)) {
        throw new Error(`Maintenance work '${workId}' has no valid canary commit`);
    }
    const existingOutcome = parseCanaryOutcome(work.canaryOutcome);
    if (existingOutcome?.deployedRevision) {
        throw new Error(`Maintenance work '${workId}' was already deployed at revision ${existingOutcome.deployedRevision}`);
    }
    const issue = getIssue(work.issueId);
    if (!issue) throw new Error(`Maintenance work '${workId}' references unknown issue '${work.issueId}'`);

    const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
    const spawnFn = options.spawn ?? defaultSpawn;
    const gateTimeoutMs = options.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    const observationWindowMs = options.observationWindowMs ?? DEFAULT_OBSERVATION_WINDOW_MS;
    const sandboxSpawnFactory = options.sandboxSpawnFactory ?? defaultSandboxSpawnFactory;
    const now = options.now ?? (() => Date.now());
    const restrictedEnv = env(repoRoot, 'autonomous-deploy-home');

    const status = await spawnFn(['git', 'status', '--porcelain', '--untracked-files=no'], {
        cwd: repoRoot,
        env: restrictedEnv,
        timeoutMs: 15_000,
    });
    if (!status.success || status.stdout.trim()) {
        throw new Error(
            `Cannot deploy into a dirty or unreadable target checkout: exit=${status.exitCode} stdout=${JSON.stringify(status.stdout)}`
        );
    }

    const paths = await spawnFn(['git', 'diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', work.commitSha], {
        cwd: repoRoot,
        env: restrictedEnv,
        timeoutMs: 15_000,
    });
    if (!paths.success) throw new Error(`Cannot inspect canary commit '${work.commitSha}': ${paths.stderr}`);
    const changedPaths = paths.stdout.split('\n').map(path => path.trim()).filter(Boolean);
    if (changedPaths.length === 0 || changedPaths.some(path => !isDeployPathAllowed(path))) {
        throw new Error(`Canary commit '${work.commitSha}' contains missing or disallowed paths`);
    }

    const alreadyApplied = await spawnFn(['git', 'merge-base', '--is-ancestor', work.commitSha, 'HEAD'], {
        cwd: repoRoot,
        env: restrictedEnv,
        timeoutMs: 15_000,
    });
    // Whether *this call* is the one that actually cherry-picked the
    // commit into the live checkout. If the commit was already an
    // ancestor of HEAD (e.g. a previous, possibly concurrent, deploy call
    // already applied it), this call must never treat a later gate
    // failure as something it can fix by reverting - HEAD may by then be
    // an entirely unrelated commit with nothing to do with this work item.
    const deployedByThisCall = !alreadyApplied.success;
    if (deployedByThisCall) {
        const cherryPick = await spawnFn(['git', 'cherry-pick', work.commitSha], {
            cwd: repoRoot,
            env: restrictedEnv,
            timeoutMs: gateTimeoutMs,
        });
        if (!cherryPick.success) {
            await spawnFn(['git', 'cherry-pick', '--abort'], { cwd: repoRoot, env: restrictedEnv, timeoutMs: 15_000 }).catch(() => undefined);
            // Uses attempts + 1 (not the stale, pre-this-failure count):
            // this failure is a genuinely new attempt that must escalate
            // the backoff, never repeat the same wait as a prior failure.
            const nextRetryAt = computeNextRetryAt(issue.attempts + 1, now());
            const reason = `deployment cherry-pick failed: ${cherryPick.stderr.slice(-1000)}`;
            transitionMaintenanceWork({ id: workId, status: 'failed', rollbackReason: reason });
            transitionIssue({ id: work.issueId, status: 'failed', resolutionEvidence: reason, nextRetryAt, incrementAttempts: true });
            log('maintenance_work', { workId, issueId: work.issueId, status: 'failed', stage: 'deploy_cherry_pick', reason });
            const record = getMaintenanceWork(workId);
            if (!record) throw new Error(`maintenance work '${workId}' vanished after failed deployment`);
            return record;
        }
    }

    // The exact revision this call is about to verify: either the commit
    // it just cherry-picked, or (if the canary commit was already an
    // ancestor) whatever HEAD already was before this call touched
    // anything. Captured now, before the gate runs, so a later revert (if
    // any) always targets this precise revision rather than a
    // possibly-since-moved-on `HEAD`.
    const headRevision = await spawnFn(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot, env: restrictedEnv, timeoutMs: 15_000 });
    if (!headRevision.success) throw new Error(`Cannot read HEAD revision before running the post-deployment gate: ${headRevision.stderr}`);
    const candidateRevision = headRevision.stdout.trim();
    const rollbackRevision = deployedByThisCall ? candidateRevision : work.commitSha;

    const gate = await verifyRevisionInDisposableWorktree(spawnFn, repoRoot, candidateRevision, restrictedEnv, gateTimeoutMs, sandboxSpawnFactory);
    if (!gate.success) {
        if (!deployedByThisCall) {
            // This call never changed the live checkout - the canary
            // commit was already an ancestor before it ran. Reverting
            // `HEAD` here could revert a commit this call has no knowledge
            // of and no business touching. Fail for a bounded retry
            // without mutating the live checkout at all.
            const nextRetryAt = computeNextRetryAt(issue.attempts + 1, now());
            const reason =
                `post-deployment full gate failed, but the canary commit was already an ancestor of HEAD before this ` +
                `deploy call ran (not deployed by this call); leaving the live checkout untouched rather than reverting an unrelated revision: ${gate.stderr.slice(-1000)}`;
            transitionMaintenanceWork({ id: workId, status: 'failed', rollbackReason: reason });
            transitionIssue({ id: work.issueId, status: 'failed', resolutionEvidence: reason, nextRetryAt, incrementAttempts: true });
            log('maintenance_work', { workId, issueId: work.issueId, status: 'failed', stage: 'deploy_post_gate_already_applied', reason });
            const record = getMaintenanceWork(workId);
            if (!record) throw new Error(`maintenance work '${workId}' vanished after failed deployment`);
            return record;
        }
        const revert = await spawnFn(['git', 'revert', '--no-edit', candidateRevision], { cwd: repoRoot, env: restrictedEnv, timeoutMs: gateTimeoutMs });
        const nextRetryAt = computeNextRetryAt(issue.attempts + 1, now());
        const reason =
            `post-deployment full gate failed and deployment ` +
            `${revert.success ? 'was reverted' : `revert also failed: ${revert.stderr.slice(-500)}`}: ${gate.stderr.slice(-1000)}`;
        transitionMaintenanceWork({ id: workId, status: 'rolled_back', rollbackReason: reason });
        transitionIssue({ id: work.issueId, status: 'failed', resolutionEvidence: reason, nextRetryAt, incrementAttempts: true });
        if (revert.success) {
            requestDeploymentReload(`rolled back autonomous deploy for issue ${work.issueId}`, work.commitSha, options.reloadPath);
        }
        log('maintenance_work', { workId, issueId: work.issueId, status: 'rolled_back', stage: 'deploy_post_gate', reason });
        const record = getMaintenanceWork(workId);
        if (!record) throw new Error(`maintenance work '${workId}' vanished after rolled-back deployment`);
        return record;
    }

    const deployedAt = now();
    // Captured before this deploy signals a reload, so it reflects the pid
    // of whatever main-loop process was already running (if any) - the
    // process a genuine restart must differ from. Null (never blocking on
    // its own - see evaluateCanary) if no heartbeat has ever been recorded.
    const baselineMainLoopPid = readRuntimeHeartbeat('main-loop')?.pid ?? null;
    const reload = requestDeploymentReload(`deployed autonomous fix for issue ${work.issueId}`, candidateRevision, options.reloadPath);
    const outcome: AutonomousCanaryOutcome = {
        originalCommit: work.commitSha,
        changedPaths,
        baselineLastDetectedAt: issue.lastDetectedAt,
        baselineLastEvidenceAt: issue.lastEvidenceAt,
        baselineRecurrenceCount: issue.recurrenceCount,
        baselineRegistryMetrics: captureRegistryMetricsSnapshot(computeRegistryMetrics()),
        deployedAt,
        deployedRevision: candidateRevision,
        rollbackRevision,
        observationDeadlineAt: deployedAt + observationWindowMs,
        extensions: 0,
        requiredReloadGeneration: reload.generation,
        baselineMainLoopPid,
    };
    const updated = transitionMaintenanceWork({ id: workId, status: 'canary', canaryOutcome: JSON.stringify(outcome) });
    log('maintenance_work', {
        workId,
        issueId: work.issueId,
        status: 'canary',
        stage: 'deployed',
        deployedRevision: outcome.deployedRevision,
        observationDeadlineAt: outcome.observationDeadlineAt,
        requiredReloadGeneration: outcome.requiredReloadGeneration,
        baselineMainLoopPid: outcome.baselineMainLoopPid,
    });
    return updated;
}

/**
 * Verified rollback of a deployed autonomous commit: `git revert --no-edit`
 * on the clean live checkout, re-verified by the full gate (against a
 * disposable, sandboxed worktree at the exact reverted revision - never
 * the live checkout itself), with a deployment reload signal so every
 * running process reloads the reverted code. The issue is reopened for a
 * bounded retry - never left "resolved" and never handed to a human for a
 * purely technical regression.
 *
 * If the revert itself lands (a real commit exists in the live checkout)
 * but the post-revert gate then fails on that reverted tree, this is a
 * terminal outcome for this rollback attempt, not a reason to leave the
 * maintenance work sitting in `canary` for the next scan to retry an
 * identical revert against an identical, still-broken tree forever: the
 * work is persisted as `rolled_back` with evidence that the revert landed,
 * a reload is still requested (the live checkout's code really did
 * change), and the issue stays development-owned/`failed` for a bounded
 * retry or manual diagnosis.
 */
export async function rollbackAutonomousDeployment(
    workId: string,
    reason: string,
    options: AutonomousDeploymentOptions = {}
): Promise<MaintenanceWorkRecord> {
    const work = getMaintenanceWork(workId);
    if (!work) throw new Error(`No maintenance work with id '${workId}'`);
    const outcome = parseCanaryOutcome(work.canaryOutcome);
    if (!outcome?.deployedRevision || !outcome.rollbackRevision) {
        throw new Error(`Maintenance work '${workId}' has not been deployed; nothing to roll back`);
    }
    const issue = getIssue(work.issueId);
    if (!issue) throw new Error(`Maintenance work '${workId}' references unknown issue '${work.issueId}'`);

    const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
    const spawnFn = options.spawn ?? defaultSpawn;
    const gateTimeoutMs = options.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    const sandboxSpawnFactory = options.sandboxSpawnFactory ?? defaultSandboxSpawnFactory;
    const now = options.now ?? (() => Date.now());
    const restrictedEnv = env(repoRoot, 'autonomous-rollback-home');

    const status = await spawnFn(['git', 'status', '--porcelain', '--untracked-files=no'], {
        cwd: repoRoot,
        env: restrictedEnv,
        timeoutMs: 15_000,
    });
    if (!status.success || status.stdout.trim()) {
        throw new Error(
            `Cannot roll back into a dirty or unreadable target checkout: exit=${status.exitCode} stdout=${JSON.stringify(status.stdout)}`
        );
    }

    const revert = await spawnFn(['git', 'revert', '--no-edit', outcome.rollbackRevision], {
        cwd: repoRoot,
        env: restrictedEnv,
        timeoutMs: gateTimeoutMs,
    });
    if (!revert.success) {
        // A revert conflict on an otherwise-clean checkout is an
        // exceptional git-state problem, not an ordinary technical
        // failure the autonomous agent can retry its way out of. It is
        // logged loudly and the maintenance work is left in 'canary' so the
        // next scan retries the rollback rather than silently giving up or
        // leaving a broken deploy marked resolved.
        await spawnFn(['git', 'revert', '--abort'], { cwd: repoRoot, env: restrictedEnv, timeoutMs: 15_000 }).catch(() => undefined);
        log('development_error', {
            stage: 'autonomous_rollback_revert_failed',
            workId,
            issueId: work.issueId,
            deployedRevision: outcome.deployedRevision,
            rollbackRevision: outcome.rollbackRevision,
            error: revert.stderr.slice(-1000),
        });
        throw new Error(`Verified rollback failed: git revert conflict on '${outcome.rollbackRevision}': ${revert.stderr.slice(-1000)}`);
    }

    // The revert commit now genuinely exists in the live checkout - from
    // this point on, a gate failure is never treated as "the rollback
    // didn't happen, try again" (it did happen, and retrying would just
    // revert the identical already-reverted tree again). Captured
    // immediately so the terminal-state path below always references the
    // exact revision that landed, not a possibly-since-moved-on `HEAD`.
    const revertedHead = await spawnFn(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot, env: restrictedEnv, timeoutMs: 15_000 });
    if (!revertedHead.success) {
        log('development_error', {
            stage: 'autonomous_rollback_head_unreadable',
            workId,
            issueId: work.issueId,
            error: revertedHead.stderr.slice(-1000),
        });
        throw new Error(`Verified rollback failed: cannot read HEAD after a successful revert: ${revertedHead.stderr.slice(-1000)}`);
    }
    const revertedRevision = revertedHead.stdout.trim();

    const gate = await verifyRevisionInDisposableWorktree(spawnFn, repoRoot, revertedRevision, restrictedEnv, gateTimeoutMs, sandboxSpawnFactory);
    if (!gate.success) {
        // The revert landed, but the reverted tree itself fails baseline
        // checks (e.g. the "fix" this rolls back was itself masking - or
        // was unrelated to - a pre-existing break). Never leave this
        // maintenance work in 'canary' (the next scan would just retry the
        // identical revert against the identical still-broken tree
        // forever): persist a terminal state now, still request a reload
        // (the live checkout's code genuinely changed), and leave the
        // issue development-owned/failed for a bounded retry or manual
        // diagnosis rather than silently repeating this revert.
        const gateFailureReason =
            `git revert landed (revision ${revertedRevision}) but the post-revert full gate failed on the reverted tree: ${gate.stderr.slice(-1000)}`;
        const nextRetryAt = computeNextRetryAt(issue.attempts + 1, now());
        const rolledBack = transitionMaintenanceWork({ id: workId, status: 'rolled_back', rollbackReason: gateFailureReason });
        transitionIssue({ id: work.issueId, status: 'failed', resolutionEvidence: gateFailureReason, nextRetryAt, incrementAttempts: true });
        requestDeploymentReload(`rolled back (post-revert gate failed) autonomous deploy for issue ${work.issueId}`, revertedRevision, options.reloadPath);
        log('development_error', {
            stage: 'autonomous_rollback_gate_failed',
            workId,
            issueId: work.issueId,
            revertedRevision,
            error: gate.stderr.slice(-1000),
        });
        log('maintenance_work', { workId, issueId: work.issueId, status: 'rolled_back', reason: gateFailureReason, nextRetryAt });
        return rolledBack;
    }

    const nextRetryAt = computeNextRetryAt(issue.attempts + 1, now());
    const rolledBack = transitionMaintenanceWork({ id: workId, status: 'rolled_back', rollbackReason: reason });
    transitionIssue({ id: work.issueId, status: 'failed', resolutionEvidence: reason, nextRetryAt, incrementAttempts: true });
    requestDeploymentReload(`rolled back autonomous deploy for issue ${work.issueId}`, outcome.deployedRevision, options.reloadPath);
    log('maintenance_work', { workId, issueId: work.issueId, status: 'rolled_back', reason, nextRetryAt });
    return rolledBack;
}

/**
 * Called every maintenance scan for every deployed autonomous canary:
 * rolls back on redetection/regression, promotes/resolves once the
 * observation window elapses with fresh heartbeats and no recurrence, or
 * extends the window boundedly when telemetry is inconclusive.
 */
export async function evaluateAutonomousCanaries(options: AutonomousDeploymentOptions = {}): Promise<void> {
    const now = options.now ?? (() => Date.now());
    const maxExtensions = options.maxExtensions ?? DEFAULT_MAX_EXTENSIONS;
    const extensionWindowMs = options.extensionWindowMs ?? DEFAULT_EXTENSION_WINDOW_MS;

    // Filtered at the SQL layer (canaryDeploymentState: 'deployed', before
    // LIMIT) and ordered by soonest observation deadline first, so a large
    // number of not-yet-deployed pending canaries for the same recipe can
    // never crowd genuinely deployed (awaiting evaluation) canaries out of
    // this bounded page - see ListMaintenanceWorkFilter.canaryDeploymentState
    // in maintenanceStore.ts. Every fetched row is therefore guaranteed to
    // have a deployedRevision; parseCanaryOutcome is still re-checked below
    // purely as defense in depth against a malformed/corrupt row.
    for (const work of listMaintenanceWork({
        status: 'canary',
        recipeId: AUTONOMOUS_RECIPE_ID,
        canaryDeploymentState: 'deployed',
        orderBy: 'canary_deadline_asc',
        limit: 50,
    })) {
        const outcome = parseCanaryOutcome(work.canaryOutcome);
        if (!outcome) continue;
        if (!outcome.deployedRevision) {
            // Not yet deployed - the maintenance runner's scan loop deploys
            // fresh canaries separately (deployAutonomousMaintenanceWork).
            continue;
        }
        const issue = getIssue(work.issueId);
        if (!issue) {
            log('development_error', { stage: 'autonomous_canary_evaluation', workId: work.id, error: `unknown issue '${work.issueId}'` });
            continue;
        }
        const currentMetrics = captureRegistryMetricsSnapshot(computeRegistryMetrics());
        const mainLoopHeartbeat = readRuntimeHeartbeat('main-loop');
        const decision = evaluateCanary({
            outcome,
            issue,
            currentMetrics,
            now: now(),
            mainLoopHeartbeat,
            maxExtensions,
            extensionWindowMs,
        });

        if (decision.action === 'wait') continue;
        if (decision.action === 'rollback') {
            await rollbackAutonomousDeployment(work.id, decision.reason, options).catch(error =>
                log('development_error', { stage: 'autonomous_canary_rollback', workId: work.id, error: String(error) })
            );
            continue;
        }
        if (decision.action === 'extend') {
            const extended: AutonomousCanaryOutcome = {
                ...outcome,
                extensions: outcome.extensions + 1,
                observationDeadlineAt: (outcome.observationDeadlineAt ?? now()) + extensionWindowMs,
            };
            transitionMaintenanceWork({ id: work.id, status: 'canary', canaryOutcome: JSON.stringify(extended) });
            log('maintenance_work', {
                workId: work.id,
                issueId: work.issueId,
                status: 'canary',
                stage: 'observation_extended',
                extensions: extended.extensions,
                reason: decision.reason,
            });
            continue;
        }
        // decision.action === 'promote'
        const promoted = transitionMaintenanceWork({ id: work.id, status: 'promoted' });
        transitionIssue({ id: work.issueId, status: 'resolved', resolutionEvidence: decision.reason });
        log('maintenance_work', { workId: promoted.id, issueId: work.issueId, status: 'promoted', reason: decision.reason });
    }
}
