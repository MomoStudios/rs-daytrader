import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { _resetRegistryForTests } from '../lib/registryDb';
import { _setLogDataDirForTests } from '../lib/logger';
import { _setRuntimeHealthDataDirForTests, type RuntimeHeartbeat } from '../lib/runtimeHealth';
import { getIssue, recordIssue, transitionIssue, type IssueRecord } from '../lib/issueRegistry';
import { getMaintenanceWork, transitionMaintenanceWork, type MaintenanceWorkRecord } from '../lib/maintenanceStore';
import { AUTONOMOUS_RECIPE_ID, runAutonomousMaintenanceWork as realRunAutonomousMaintenanceWork } from '../maintenance/autonomousWorkerRunner';
import {
    deployAutonomousMaintenanceWork as realDeployAutonomousMaintenanceWork,
    evaluateAutonomousCanaries as realEvaluateAutonomousCanaries,
    evaluateCanary,
    hasMetricsRegressed,
    parseCanaryOutcome,
    rollbackAutonomousDeployment as realRollbackAutonomousDeployment,
    wasIssueRedetectedAfterDeployment,
    type AutonomousCanaryOutcome,
    type AutonomousDeploymentOptions,
} from '../maintenance/autonomousDeployment';
import type { RunAutonomousMaintenanceWorkOptions } from '../maintenance/autonomousWorkerRunner';
import { computeNextRetryAt } from '../maintenance/autonomousRetryPolicy';
import { getDeploymentReloadState } from '../lib/deploymentReload';
import { _setPinnedGateStepsForTests } from '../maintenance/pinnedGate';
import { identitySandboxSpawnFactory } from '../maintenance/bwrapSandbox';

/**
 * Every test in this file uses a fixture pinned-gate script pointed at by a
 * fixed real host path (see `_setPinnedGateStepsForTests` below), not one
 * built from translatable sandbox mounts - it is not meant to exercise
 * bubblewrap itself (see bwrapSandbox.test.ts for the one focused test that
 * does), only the worker/deployment/rollback orchestration logic. Every
 * call here therefore defaults to the unsandboxed test factory.
 */
function runAutonomousMaintenanceWork(issue: IssueRecord, options: RunAutonomousMaintenanceWorkOptions = {}) {
    return realRunAutonomousMaintenanceWork(issue, { sandboxSpawnFactory: identitySandboxSpawnFactory, ...options });
}
function deployAutonomousMaintenanceWork(workId: string, options: AutonomousDeploymentOptions = {}) {
    return realDeployAutonomousMaintenanceWork(workId, { sandboxSpawnFactory: identitySandboxSpawnFactory, ...options });
}
function rollbackAutonomousDeployment(workId: string, reason: string, options: AutonomousDeploymentOptions = {}) {
    return realRollbackAutonomousDeployment(workId, reason, { sandboxSpawnFactory: identitySandboxSpawnFactory, ...options });
}
function evaluateAutonomousCanaries(options: AutonomousDeploymentOptions = {}) {
    return realEvaluateAutonomousCanaries({ sandboxSpawnFactory: identitySandboxSpawnFactory, ...options });
}

const DATA_DIR = join(import.meta.dir, '..', 'data');
let repoRoot: string;
let worktreeParentDir: string;
let reloadPath: string;

function run(argv: string[]): void {
    const result = Bun.spawnSync({ cmd: argv, cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) {
        throw new Error(`fixture command failed: ${argv.join(' ')}: ${result.stderr?.toString() ?? ''}`);
    }
}

function initScratchRepo(): void {
    repoRoot = mkdtempSync(join(DATA_DIR, 'autonomous-deploy-repo-'));
    worktreeParentDir = join(repoRoot, '.worktrees');
    reloadPath = join(repoRoot, 'deployment-reload.json');
    run(['git', 'init', '-q']);
    run(['git', 'config', 'user.email', 'bot@example.com']);
    run(['git', 'config', 'user.name', 'DayTrader Bot']);
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'fixture-repo', scripts: { check: 'bun run gate-check.ts' } }));
    // The deploy/rollback gate now always runs against a disposable,
    // detached worktree at the exact deployed/reverted revision - never
    // directly against `repoRoot`'s own working directory (see
    // verifyRevisionInDisposableWorktree in autonomousDeployment.ts) - so
    // the fixture's "should this run fail" sentinel must be an absolute
    // path baked in at fixture-creation time, not a path relative to
    // whatever directory the gate step's cwd happens to be.
    const sentinelPath = join(repoRoot, '.should-fail-gate').replace(/\\/g, '\\\\');
    writeFileSync(
        join(repoRoot, 'gate-check.ts'),
        [
            "const fs = require('fs');",
            `if (fs.existsSync('${sentinelPath}')) { console.error('gate failure requested by fixture'); process.exit(1); }`,
            "console.log('gate passed');",
            'process.exit(0);',
        ].join('\n')
    );
    mkdirSync(join(repoRoot, 'lib'), { recursive: true });
    writeFileSync(join(repoRoot, 'lib', 'thing.ts'), 'export const value = 1;\n');
    run(['git', 'add', '-A']);
    run(['git', 'commit', '-q', '-m', 'initial scratch repo state']);
}

function currentHead(): string {
    return Bun.spawnSync({ cmd: ['git', 'rev-parse', 'HEAD'], cwd: repoRoot }).stdout.toString().trim();
}

function developmentIssue(overrides: Partial<Parameters<typeof recordIssue>[0]> = {}): IssueRecord {
    return recordIssue({
        fingerprint: `deploy-issue-${Math.random()}`,
        ownerLayer: 'development',
        severity: 'medium',
        category: 'failure',
        title: 'Reservation window off-by-one',
        description: 'A recurring technical defect with no pre-authored recipe.',
        evidence: ['decisions.jsonl:42'],
        ...overrides,
    });
}

/** Builds a real canary maintenance_work row (with a real commit) via the worker runner, using a scripted agent. */
async function buildCanaryWork(issue: IssueRecord): Promise<MaintenanceWorkRecord> {
    const work = await runAutonomousMaintenanceWork(issue, {
        repoRoot,
        worktreeParentDir,
        agentRun: async ({ worktreePath }) => {
            writeFileSync(join(worktreePath, 'lib', 'thing.ts'), 'export const value = 2;\n');
            return { outcome: 'resolved', summary: 'Fixed the off-by-one.', rootCause: 'Wrong comparator.', testsRun: [], humanQuestion: null, directionKind: null };
        },
    });
    expect(work.status).toBe('canary');
    return work;
}

beforeEach(() => {
    _resetRegistryForTests(':memory:');
    initScratchRepo();
    _setLogDataDirForTests(repoRoot);
    _setRuntimeHealthDataDirForTests(join(repoRoot, 'bots', 'DayTrader', 'data'));
    // The pinned gate (see pinnedGate.ts) never resolves anything from
    // package.json - in tests it must be pointed at the fixture's own fast
    // pass/fail script rather than a real tsc/full test suite run.
    _setPinnedGateStepsForTests([{ label: 'fixture gate', argv: [process.execPath, join(repoRoot, 'gate-check.ts')] }]);
});

afterEach(() => {
    _resetRegistryForTests(':memory:');
    _setPinnedGateStepsForTests(null);
    rmSync(repoRoot, { recursive: true, force: true });
});

describe('autonomousDeployment - deployAutonomousMaintenanceWork', () => {
    test('cherry-picks the canary commit into a clean target, re-runs the gate, and records a bounded observation deadline (never resolves outright)', async () => {
        const issue = developmentIssue({ fingerprint: 'deploy-success-issue' });
        const canary = await buildCanaryWork(issue);
        const headBefore = currentHead();

        const deployed = await deployAutonomousMaintenanceWork(canary.id, { repoRoot, reloadPath });
        expect(deployed.status).toBe('canary'); // deployment success is not resolution
        const outcome = parseCanaryOutcome(deployed.canaryOutcome);
        expect(outcome?.deployedRevision).toBeTruthy();
        expect(outcome?.observationDeadlineAt).toBeGreaterThan(Date.now());
        expect(outcome?.originalCommit).toBe(canary.commitSha as string);

        expect(currentHead()).not.toBe(headBefore); // the live checkout actually changed
        expect(readFileSync(join(repoRoot, 'lib', 'thing.ts'), 'utf8')).toContain('value = 2');

        const issueAfter = getIssue(issue.id);
        expect(issueAfter?.status).toBe('canary'); // still not resolved

        // A reload was requested so running processes pick up the new code.
        expect(getDeploymentReloadState(reloadPath).generation).toBeGreaterThan(0);
        expect(getDeploymentReloadState(reloadPath).deployedRevision).toBe(outcome?.deployedRevision ?? null);
    }, 30_000);

    test('refuses to deploy into a dirty target checkout', async () => {
        const issue = developmentIssue({ fingerprint: 'dirty-target-issue' });
        const canary = await buildCanaryWork(issue);
        writeFileSync(join(repoRoot, 'lib', 'thing.ts'), 'export const value = 999; // uncommitted local edit\n');
        await expect(deployAutonomousMaintenanceWork(canary.id, { repoRoot, reloadPath })).rejects.toThrow('dirty');
    }, 30_000);

    test('refuses to deploy the same work item twice', async () => {
        const issue = developmentIssue({ fingerprint: 'double-deploy-issue' });
        const canary = await buildCanaryWork(issue);
        await deployAutonomousMaintenanceWork(canary.id, { repoRoot, reloadPath });
        await expect(deployAutonomousMaintenanceWork(canary.id, { repoRoot, reloadPath })).rejects.toThrow('was already deployed');
    }, 30_000);

    test('rolls back and schedules a retry when the post-deployment gate fails', async () => {
        const issue = developmentIssue({ fingerprint: 'post-gate-fail-issue' });
        // Build the canary against a healthy repo first (so the worker's own
        // gate passes and it actually reaches canary)...
        const canary = await buildCanaryWork(issue);
        // ...then poison the *target* repo afterward, simulating a
        // regression introduced by something else between canary creation
        // and deployment. Cherry-picking the canary's commit on top of this
        // now fails the post-deployment gate.
        writeFileSync(join(repoRoot, '.should-fail-gate'), '1');
        run(['git', 'add', '-A']);
        run(['git', 'commit', '-q', '-m', 'poison the gate for this test']);
        const headBeforeDeploy = currentHead();

        const result = await deployAutonomousMaintenanceWork(canary.id, { repoRoot, reloadPath });
        expect(result.status).toBe('rolled_back');
        const issueAfter = getIssue(issue.id);
        expect(issueAfter?.status).toBe('failed');
        expect(issueAfter?.ownerLayer).toBe('development');
        expect(issueAfter?.nextRetryAt).toBeGreaterThan(Date.now());
        // The revert restored the checkout to its pre-deploy content.
        expect(readFileSync(join(repoRoot, 'lib', 'thing.ts'), 'utf8')).toContain('value = 1');
        expect(currentHead()).not.toBe(headBeforeDeploy); // deploy+revert both happened (new commits either way)
    }, 30_000);

    test('escalates the retry backoff using the incremented attempts count on a post-deployment gate failure, not the stale pre-deploy value', async () => {
        const issue = developmentIssue({ fingerprint: 'exact-backoff-deploy-gate-fail' });
        const canary = await buildCanaryWork(issue);
        // The one repair attempt so far ('repairing' claim transition)
        // already incremented attempts to 1.
        expect(getIssue(issue.id)?.attempts).toBe(1);

        writeFileSync(join(repoRoot, '.should-fail-gate'), '1');
        run(['git', 'add', '-A']);
        run(['git', 'commit', '-q', '-m', 'poison the gate for this test']);

        const fixedNow = 7_000_000;
        const result = await deployAutonomousMaintenanceWork(canary.id, { repoRoot, reloadPath, now: () => fixedNow });
        expect(result.status).toBe('rolled_back');
        const issueAfter = getIssue(issue.id)!;
        // This deploy-time failure is a genuinely new attempt: attempts
        // must escalate from 1 to 2, and the backoff computed from the
        // freshly incremented value (2), never the stale pre-deploy value
        // (1) which would understate the wait and never actually escalate
        // across repeated deploy failures.
        expect(issueAfter.attempts).toBe(2);
        expect(issueAfter.nextRetryAt).toBe(computeNextRetryAt(2, fixedNow));
    }, 30_000);

    test('never reverts an unrelated HEAD when the canary commit was already an ancestor before this call and the post-deployment gate fails', async () => {
        const issue = developmentIssue({ fingerprint: 'already-ancestor-issue' });
        const canary = await buildCanaryWork(issue);

        // Simulate the canary commit having already been applied to the
        // live checkout by some other process/call (e.g. a crash between a
        // previous deploy's cherry-pick and recording its outcome), so this
        // call's own ancestry check finds it already applied.
        run(['git', 'merge', '--ff-only', canary.branchName as string]);
        // Something entirely unrelated lands on top afterward - exactly the
        // commit a blind `git revert HEAD` would wrongly touch.
        writeFileSync(join(repoRoot, 'unrelated.ts'), 'export const unrelated = 1;\n');
        run(['git', 'add', '-A']);
        run(['git', 'commit', '-q', '-m', 'unrelated commit after the canary was already applied']);
        // Poison the gate so this deploy call's post-deployment check fails.
        writeFileSync(join(repoRoot, '.should-fail-gate'), '1');
        run(['git', 'add', '-A']);
        run(['git', 'commit', '-q', '-m', 'poison the gate for this test']);
        const headBeforeDeployCall = currentHead();

        const result = await deployAutonomousMaintenanceWork(canary.id, { repoRoot, reloadPath });
        expect(result.status).toBe('failed'); // never 'rolled_back' - nothing was reverted
        expect(currentHead()).toBe(headBeforeDeployCall); // HEAD is completely untouched, including the unrelated commit
        expect(readFileSync(join(repoRoot, 'unrelated.ts'), 'utf8')).toContain('unrelated = 1'); // never reverted
        const issueAfter = getIssue(issue.id);
        expect(issueAfter?.status).toBe('failed');
        expect(issueAfter?.ownerLayer).toBe('development');
        expect(issueAfter?.nextRetryAt).toBeGreaterThan(Date.now());
    }, 30_000);

    test('records the autonomous commit as rollback target when an already-applied canary has newer commits above it', async () => {
        const issue = developmentIssue({ fingerprint: 'already-applied-rollback-target' });
        const canary = await buildCanaryWork(issue);
        run(['git', 'merge', '--ff-only', canary.branchName as string]);
        writeFileSync(join(repoRoot, 'later.ts'), 'export const later = true;\n');
        run(['git', 'add', '-A']);
        run(['git', 'commit', '-q', '-m', 'later unrelated commit']);
        const unrelatedHead = currentHead();

        const deployed = await deployAutonomousMaintenanceWork(canary.id, { repoRoot, reloadPath });
        const outcome = parseCanaryOutcome(deployed.canaryOutcome);
        expect(outcome?.deployedRevision).toBe(unrelatedHead);
        expect(outcome?.rollbackRevision).toBe(canary.commitSha);
        expect(outcome?.rollbackRevision).not.toBe(unrelatedHead);
    }, 30_000);
});

describe('autonomousDeployment - pure canary evaluation decisions', () => {
    function outcome(overrides: Partial<AutonomousCanaryOutcome> = {}): AutonomousCanaryOutcome {
        return {
            originalCommit: 'a'.repeat(40),
            changedPaths: ['lib/thing.ts'],
            baselineLastDetectedAt: 1000,
            baselineLastEvidenceAt: null,
            baselineRecurrenceCount: 0,
            baselineRegistryMetrics: { openIssues: 5, overdueIssues: 1 },
            deployedAt: 1000,
            deployedRevision: 'b'.repeat(40),
            rollbackRevision: 'b'.repeat(40),
            observationDeadlineAt: 2000,
            extensions: 0,
            requiredReloadGeneration: 5,
            baselineMainLoopPid: 111,
            ...overrides,
        };
    }

    // A heartbeat from a genuinely restarted process: a higher/equal
    // deploymentGeneration than the outcome requires, and a different pid
    // than the pre-deploy baseline. Individual tests override `at` (and
    // occasionally generation/pid) to build the exact scenario under test.
    function freshHeartbeat(at: number, overrides: Partial<RuntimeHeartbeat> = {}): RuntimeHeartbeat {
        return { process: 'main-loop', pid: 222, phase: 'loop', at, deploymentGeneration: 5, ...overrides };
    }
    // A heartbeat from the same old process that was already running
    // before the deploy: same pid, and (crucially) still stuck on the
    // pre-deploy generation it captured at its own startup - it can never
    // advance without an actual restart, no matter how recent `at` is.
    function staleHeartbeat(at: number, overrides: Partial<RuntimeHeartbeat> = {}): RuntimeHeartbeat {
        return { process: 'main-loop', pid: 111, phase: 'loop', at, deploymentGeneration: 4, ...overrides };
    }

    test('rolls back when the issue was redetected after deployment (no evidence-occurrence tracking; falls back to lastDetectedAt)', () => {
        const decision = evaluateCanary({
            outcome: outcome(),
            issue: { lastDetectedAt: 1500, lastEvidenceAt: null }, // after deployedAt=1000
            currentMetrics: { openIssues: 5, overdueIssues: 1 },
            now: 2500,
            mainLoopHeartbeat: freshHeartbeat(2000),
        });
        expect(decision.action).toBe('rollback');
    });

    test('rolls back when both open and overdue metrics materially regress', () => {
        const decision = evaluateCanary({
            outcome: outcome(),
            issue: { lastDetectedAt: 900, lastEvidenceAt: null },
            currentMetrics: { openIssues: 8, overdueIssues: 3 },
            now: 2500,
            mainLoopHeartbeat: freshHeartbeat(2000),
        });
        expect(decision.action).toBe('rollback');
    });

    test('does not roll back on a single noisy metric (only open issues increased)', () => {
        const decision = evaluateCanary({
            outcome: outcome({ observationDeadlineAt: 5000 }),
            issue: { lastDetectedAt: 900, lastEvidenceAt: null },
            currentMetrics: { openIssues: 8, overdueIssues: 1 },
            now: 2500,
            mainLoopHeartbeat: freshHeartbeat(2000),
        });
        expect(decision.action).toBe('wait');
    });

    test('waits while still inside the observation window with no regression', () => {
        const decision = evaluateCanary({
            outcome: outcome({ observationDeadlineAt: 5000 }),
            issue: { lastDetectedAt: 900, lastEvidenceAt: null },
            currentMetrics: { openIssues: 5, overdueIssues: 1 },
            now: 2500,
            mainLoopHeartbeat: freshHeartbeat(2000),
        });
        expect(decision.action).toBe('wait');
    });

    test('promotes after the deadline elapses with a fresh heartbeat and no recurrence/regression', () => {
        const decision = evaluateCanary({
            outcome: outcome({ observationDeadlineAt: 2000 }),
            issue: { lastDetectedAt: 900, lastEvidenceAt: null },
            currentMetrics: { openIssues: 5, overdueIssues: 1 },
            now: 2500,
            mainLoopHeartbeat: freshHeartbeat(2200), // after deployedAt=1000, confirms the system is alive on the new code
        });
        expect(decision.action).toBe('promote');
    });

    test('extends boundedly when the deadline elapses but no fresh heartbeat has been observed yet', () => {
        const decision = evaluateCanary({
            outcome: outcome({ observationDeadlineAt: 2000, extensions: 0 }),
            issue: { lastDetectedAt: 900, lastEvidenceAt: null },
            currentMetrics: { openIssues: 5, overdueIssues: 1 },
            now: 2500,
            mainLoopHeartbeat: null,
        });
        expect(decision.action).toBe('extend');
    });

    test('rolls back (never promotes) once the maximum number of extensions is exhausted without ever seeing a fresh heartbeat', () => {
        const decision = evaluateCanary({
            outcome: outcome({ observationDeadlineAt: 2000, extensions: 3 }),
            issue: { lastDetectedAt: 900, lastEvidenceAt: null },
            currentMetrics: { openIssues: 5, overdueIssues: 1 },
            now: 2500,
            mainLoopHeartbeat: null,
            maxExtensions: 3,
        });
        expect(decision.action).toBe('rollback');
    });

    test('does not promote (extends instead) on a stale heartbeat from the same old process still stuck on the pre-deploy generation, even though its timestamp is recent', () => {
        // The bug this guards against: the old process keeps writing
        // "loop"/"stopping" heartbeats for a while after a deploy/reload
        // request lands, right up until it next checks isReloadRequested()
        // between iterations and exits. A bare "heartbeat timestamp is
        // after deployedAt" check would wrongly treat this as proof the
        // deploy took effect. Requiring deploymentGeneration >=
        // requiredReloadGeneration closes that hole: this heartbeat's
        // generation (4) is still behind what this deploy required (5).
        const decision = evaluateCanary({
            outcome: outcome({ observationDeadlineAt: 2000, requiredReloadGeneration: 5, baselineMainLoopPid: 111 }),
            issue: { lastDetectedAt: 900, lastEvidenceAt: null },
            currentMetrics: { openIssues: 5, overdueIssues: 1 },
            now: 2500,
            mainLoopHeartbeat: staleHeartbeat(2400), // recent timestamp, but generation 4 < required 5, and pid === baseline
        });
        expect(decision.action).toBe('extend');
    });

    test('rolls back (never promotes) a stale old-process heartbeat once bounded extensions are exhausted', () => {
        const decision = evaluateCanary({
            outcome: outcome({ observationDeadlineAt: 2000, requiredReloadGeneration: 5, baselineMainLoopPid: 111, extensions: 3 }),
            issue: { lastDetectedAt: 900, lastEvidenceAt: null },
            currentMetrics: { openIssues: 5, overdueIssues: 1 },
            now: 2500,
            mainLoopHeartbeat: staleHeartbeat(2400),
            maxExtensions: 3,
        });
        expect(decision.action).toBe('rollback');
    });

    test('promotes once the restarted process reports a heartbeat with generation >= required and a different pid than the pre-deploy baseline', () => {
        const decision = evaluateCanary({
            outcome: outcome({ observationDeadlineAt: 2000, requiredReloadGeneration: 5, baselineMainLoopPid: 111 }),
            issue: { lastDetectedAt: 900, lastEvidenceAt: null },
            currentMetrics: { openIssues: 5, overdueIssues: 1 },
            now: 2500,
            mainLoopHeartbeat: freshHeartbeat(2200, { deploymentGeneration: 5, pid: 222 }),
        });
        expect(decision.action).toBe('promote');
    });

    test('promotes on a generation strictly ahead of the required one too (a later deploy already reloaded the process)', () => {
        const decision = evaluateCanary({
            outcome: outcome({ observationDeadlineAt: 2000, requiredReloadGeneration: 5, baselineMainLoopPid: 111 }),
            issue: { lastDetectedAt: 900, lastEvidenceAt: null },
            currentMetrics: { openIssues: 5, overdueIssues: 1 },
            now: 2500,
            mainLoopHeartbeat: freshHeartbeat(2200, { deploymentGeneration: 9, pid: 333 }),
        });
        expect(decision.action).toBe('promote');
    });

    test('does not block promotion on the pid check alone when no baseline pid was ever observed (null)', () => {
        const decision = evaluateCanary({
            outcome: outcome({ observationDeadlineAt: 2000, requiredReloadGeneration: 5, baselineMainLoopPid: null }),
            issue: { lastDetectedAt: 900, lastEvidenceAt: null },
            currentMetrics: { openIssues: 5, overdueIssues: 1 },
            now: 2500,
            mainLoopHeartbeat: freshHeartbeat(2200, { deploymentGeneration: 5, pid: 111 }), // same pid as a typical baseline, but none was ever recorded
        });
        expect(decision.action).toBe('promote');
    });

    test('never promotes a heartbeat that reports a sufficient generation but still carries the exact pid the baseline had (defense in depth)', () => {
        const decision = evaluateCanary({
            outcome: outcome({ observationDeadlineAt: 2000, requiredReloadGeneration: 5, baselineMainLoopPid: 111, extensions: 3 }),
            issue: { lastDetectedAt: 900, lastEvidenceAt: null },
            currentMetrics: { openIssues: 5, overdueIssues: 1 },
            now: 2500,
            mainLoopHeartbeat: freshHeartbeat(2200, { deploymentGeneration: 5, pid: 111 }),
            maxExtensions: 3,
        });
        expect(decision.action).toBe('rollback'); // extensions exhausted, so never silently promoted
    });

    test('a legacy canary outcome parsed without requiredReloadGeneration/baselineMainLoopPid (backward-compatible defaults) can never be falsely promoted', () => {
        const legacyOutcome = parseCanaryOutcome(
            JSON.stringify({
                originalCommit: 'a'.repeat(40),
                changedPaths: ['lib/thing.ts'],
                baselineLastDetectedAt: 1000,
                baselineLastEvidenceAt: null,
                baselineRecurrenceCount: 0,
                baselineRegistryMetrics: { openIssues: 5, overdueIssues: 1 },
                deployedAt: 1000,
                deployedRevision: 'b'.repeat(40),
                rollbackRevision: 'b'.repeat(40),
                observationDeadlineAt: 2000,
                extensions: 3,
                // requiredReloadGeneration/baselineMainLoopPid deliberately omitted
            })
        )!;
        expect(legacyOutcome.requiredReloadGeneration).toBe(Infinity);
        expect(legacyOutcome.baselineMainLoopPid).toBeNull();
        const decision = evaluateCanary({
            outcome: legacyOutcome,
            issue: { lastDetectedAt: 900, lastEvidenceAt: null },
            currentMetrics: { openIssues: 5, overdueIssues: 1 },
            now: 2500,
            mainLoopHeartbeat: freshHeartbeat(2200, { deploymentGeneration: 999, pid: 222 }),
            maxExtensions: 3,
        });
        expect(decision.action).toBe('rollback'); // never promoted, even with a very high generation and a fresh timestamp
    });

    test('ignores a review that merely re-cites the exact same historical evidence (lastEvidenceAt unchanged) even though lastDetectedAt advanced', () => {
        // Simulates the false-rollback bug: recordIssue() bumped
        // lastDetectedAt because the issue was reprocessed, but the
        // evidence itself is the same pre-deploy evidence (lastEvidenceAt
        // never advanced past the baseline it had at deploy time).
        const decision = evaluateCanary({
            outcome: outcome({ baselineLastEvidenceAt: 500, observationDeadlineAt: 5000 }),
            issue: { lastDetectedAt: 1500, lastEvidenceAt: 500 }, // lastDetectedAt > baseline, but lastEvidenceAt did not advance
            currentMetrics: { openIssues: 5, overdueIssues: 1 },
            now: 2500,
            mainLoopHeartbeat: freshHeartbeat(2000),
        });
        expect(decision.action).not.toBe('rollback');
    });

    test('rolls back when genuinely fresh evidence (lastEvidenceAt) postdates the deploy, even if metrics look fine', () => {
        const decision = evaluateCanary({
            outcome: outcome({ baselineLastEvidenceAt: 500, deployedAt: 1000 }),
            issue: { lastDetectedAt: 1500, lastEvidenceAt: 1200 }, // fresh evidence after deployedAt=1000
            currentMetrics: { openIssues: 5, overdueIssues: 1 },
            now: 2500,
            mainLoopHeartbeat: freshHeartbeat(2000),
        });
        expect(decision.action).toBe('rollback');
    });

    test('wasIssueRedetectedAfterDeployment prefers lastEvidenceAt over lastDetectedAt when available, and hasMetricsRegressed is pure and independently testable', () => {
        // No evidence timestamp available: falls back to lastDetectedAt vs baselineLastDetectedAt.
        expect(
            wasIssueRedetectedAfterDeployment(
                { lastDetectedAt: 2000, lastEvidenceAt: null },
                { baselineLastDetectedAt: 1000, baselineLastEvidenceAt: null, deployedAt: 1000 }
            )
        ).toBe(true);
        expect(
            wasIssueRedetectedAfterDeployment(
                { lastDetectedAt: 500, lastEvidenceAt: null },
                { baselineLastDetectedAt: 1000, baselineLastEvidenceAt: null, deployedAt: 1000 }
            )
        ).toBe(false);
        // Evidence timestamp available: it wins, even when lastDetectedAt would suggest the opposite.
        expect(
            wasIssueRedetectedAfterDeployment(
                { lastDetectedAt: 5000, lastEvidenceAt: 500 }, // stale evidence, reprocessed later
                { baselineLastDetectedAt: 1000, baselineLastEvidenceAt: 500, deployedAt: 1000 }
            )
        ).toBe(false);
        expect(
            wasIssueRedetectedAfterDeployment(
                { lastDetectedAt: 1100, lastEvidenceAt: 1500 }, // fresh evidence
                { baselineLastDetectedAt: 1000, baselineLastEvidenceAt: 500, deployedAt: 1000 }
            )
        ).toBe(true);
        expect(hasMetricsRegressed({ openIssues: 5, overdueIssues: 1 }, { openIssues: 7, overdueIssues: 2 })).toBe(true);
        expect(hasMetricsRegressed({ openIssues: 5, overdueIssues: 1 }, { openIssues: 5, overdueIssues: 1 })).toBe(false);
    });
});

describe('autonomousDeployment - evaluateAutonomousCanaries end to end', () => {
    test('promotes and resolves a healthy deployed canary once the observation window elapses with a fresh heartbeat', async () => {
        const issue = developmentIssue({ fingerprint: 'e2e-promote-issue' });
        const canary = await buildCanaryWork(issue);
        const deployed = await deployAutonomousMaintenanceWork(canary.id, { repoRoot, reloadPath });
        const outcome = parseCanaryOutcome(deployed.canaryOutcome)!;

        // Simulate a fresh main-loop heartbeat recorded after deployment, and
        // an observation window that has already elapsed. The heartbeat's
        // deploymentGeneration must be at least the generation this deploy
        // required (see requiredReloadGeneration in the persisted outcome)
        // - a plain post-deployedAt timestamp is no longer sufficient proof
        // the restarted process actually picked up the new code.
        writeFileSync(
            join(repoRoot, 'bots', 'DayTrader', 'data', 'main-loop.heartbeat.json'),
            JSON.stringify({
                process: 'main-loop',
                pid: 999,
                phase: 'loop',
                at: outcome.deployedAt! + 1000,
                deploymentGeneration: outcome.requiredReloadGeneration,
            })
        );
        await evaluateAutonomousCanaries({
            repoRoot,
            reloadPath,
            now: () => outcome.observationDeadlineAt! + 1,
        });

        const workAfter = getMaintenanceWork(deployed.id);
        expect(workAfter?.status).toBe('promoted');
        const issueAfter = getIssue(issue.id);
        expect(issueAfter?.status).toBe('resolved');
    }, 30_000);

    test('a stale heartbeat from the same old process (unchanged generation/pid) is rejected; only a heartbeat from a genuinely restarted process (new generation, new pid) gets promoted', async () => {
        const issue = developmentIssue({ fingerprint: 'e2e-generation-restart-issue' });
        const canary = await buildCanaryWork(issue);

        // The main loop was already running (some pid, generation 0) before
        // this deploy - captured as this canary's baselineMainLoopPid.
        const heartbeatPath = join(repoRoot, 'bots', 'DayTrader', 'data', 'main-loop.heartbeat.json');
        mkdirSync(join(repoRoot, 'bots', 'DayTrader', 'data'), { recursive: true });
        writeFileSync(heartbeatPath, JSON.stringify({ process: 'main-loop', pid: 1234, phase: 'loop', at: Date.now(), deploymentGeneration: 0 }));

        const deployed = await deployAutonomousMaintenanceWork(canary.id, { repoRoot, reloadPath });
        const outcome = parseCanaryOutcome(deployed.canaryOutcome)!;
        expect(outcome.baselineMainLoopPid).toBe(1234);
        expect(outcome.requiredReloadGeneration).toBeGreaterThan(0);

        // The OLD process (same pid, same stale generation - it has not
        // restarted yet) keeps beating right up to (and past) the
        // observation deadline, exactly as it does in production between
        // the reload request landing and the process's own next
        // isReloadRequested() check. This must never be mistaken for proof
        // the deploy took effect.
        writeFileSync(
            heartbeatPath,
            JSON.stringify({ process: 'main-loop', pid: 1234, phase: 'loop', at: outcome.observationDeadlineAt! + 1, deploymentGeneration: 0 })
        );
        await evaluateAutonomousCanaries({ repoRoot, reloadPath, now: () => outcome.observationDeadlineAt! + 1 });
        const afterStaleHeartbeat = getMaintenanceWork(deployed.id);
        expect(afterStaleHeartbeat?.status).toBe('canary'); // never promoted - only extended
        const outcomeAfterExtend = parseCanaryOutcome(afterStaleHeartbeat!.canaryOutcome)!;
        expect(outcomeAfterExtend.extensions).toBe(1);
        expect(getIssue(issue.id)?.status).toBe('canary'); // never resolved on a stale heartbeat

        // The process genuinely restarts: a different pid, and a
        // deploymentGeneration it only could have captured by re-running
        // captureStartupGeneration() *after* this deploy's reload request
        // landed.
        writeFileSync(
            heartbeatPath,
            JSON.stringify({
                process: 'main-loop',
                pid: 5678,
                phase: 'loop',
                at: outcomeAfterExtend.observationDeadlineAt! + 1,
                deploymentGeneration: outcome.requiredReloadGeneration,
            })
        );
        await evaluateAutonomousCanaries({ repoRoot, reloadPath, now: () => outcomeAfterExtend.observationDeadlineAt! + 1 });
        const afterRestart = getMaintenanceWork(deployed.id);
        expect(afterRestart?.status).toBe('promoted');
        expect(getIssue(issue.id)?.status).toBe('resolved');
    }, 30_000);

    test('rolls back a deployed canary whose issue was redetected', async () => {
        const issue = developmentIssue({ fingerprint: 'e2e-rollback-issue' });
        const canary = await buildCanaryWork(issue);
        const deployed = await deployAutonomousMaintenanceWork(canary.id, { repoRoot, reloadPath });
        const outcome = parseCanaryOutcome(deployed.canaryOutcome)!;

        // The same problem was detected again after the fix was deployed.
        recordIssue({
            fingerprint: issue.fingerprint,
            ownerLayer: 'development',
            severity: 'medium',
            category: 'failure',
            title: issue.title,
            description: 'recurred',
            evidence: ['still broken'],
        });

        await evaluateAutonomousCanaries({ repoRoot, reloadPath, now: () => outcome.deployedAt! + 1000 });

        const workAfter = getMaintenanceWork(deployed.id);
        expect(workAfter?.status).toBe('rolled_back');
        const issueAfter = getIssue(issue.id);
        expect(issueAfter?.status).toBe('failed');
        expect(issueAfter?.ownerLayer).toBe('development');
        expect(readFileSync(join(repoRoot, 'lib', 'thing.ts'), 'utf8')).toContain('value = 1'); // reverted
    }, 30_000);

    test('extends the observation window boundedly when telemetry is inconclusive, without ever asking a human', async () => {
        const issue = developmentIssue({ fingerprint: 'e2e-extend-issue' });
        const canary = await buildCanaryWork(issue);
        const deployed = await deployAutonomousMaintenanceWork(canary.id, { repoRoot, reloadPath });
        const outcome = parseCanaryOutcome(deployed.canaryOutcome)!;

        await evaluateAutonomousCanaries({ repoRoot, reloadPath, now: () => outcome.observationDeadlineAt! + 1 });

        const workAfter = getMaintenanceWork(deployed.id);
        expect(workAfter?.status).toBe('canary'); // still canary, just extended
        const outcomeAfter = parseCanaryOutcome(workAfter!.canaryOutcome)!;
        expect(outcomeAfter.extensions).toBe(1);
        expect(outcomeAfter.observationDeadlineAt).toBeGreaterThan(outcome.observationDeadlineAt!);
        const issueAfter = getIssue(issue.id);
        expect(issueAfter?.ownerLayer).toBe('development'); // never routed to a human
        expect(issueAfter?.status).toBe('canary');
    }, 30_000);
});

describe('autonomousDeployment - rollbackAutonomousDeployment', () => {
    test('reverts the deployed commit, re-verifies the gate, reopens the issue for retry, and requests a reload', async () => {
        const issue = developmentIssue({ fingerprint: 'manual-rollback-issue' });
        const canary = await buildCanaryWork(issue);
        const deployed = await deployAutonomousMaintenanceWork(canary.id, { repoRoot, reloadPath });

        const rolledBack = await rollbackAutonomousDeployment(deployed.id, 'manual rollback for test', { repoRoot, reloadPath });
        expect(rolledBack.status).toBe('rolled_back');
        const issueAfter = getIssue(issue.id);
        expect(issueAfter?.status).toBe('failed');
        expect(issueAfter?.ownerLayer).toBe('development');
        expect(issueAfter?.nextRetryAt).toBeGreaterThan(Date.now());
        expect(readFileSync(join(repoRoot, 'lib', 'thing.ts'), 'utf8')).toContain('value = 1');
    }, 30_000);

    test('escalates the retry backoff using the incremented attempts count on a manual rollback, not the stale pre-rollback value', async () => {
        const issue = developmentIssue({ fingerprint: 'exact-backoff-manual-rollback' });
        const canary = await buildCanaryWork(issue);
        const deployed = await deployAutonomousMaintenanceWork(canary.id, { repoRoot, reloadPath });
        expect(getIssue(issue.id)?.attempts).toBe(1); // one repair attempt so far

        const fixedNow = 8_000_000;
        const rolledBack = await rollbackAutonomousDeployment(deployed.id, 'manual rollback for test', {
            repoRoot,
            reloadPath,
            now: () => fixedNow,
        });
        expect(rolledBack.status).toBe('rolled_back');
        const issueAfter = getIssue(issue.id)!;
        expect(issueAfter.attempts).toBe(2);
        expect(issueAfter.nextRetryAt).toBe(computeNextRetryAt(2, fixedNow));
    }, 30_000);

    test('refuses to roll back a work item that was never deployed', async () => {
        const issue = developmentIssue({ fingerprint: 'never-deployed-issue' });
        const canary = await buildCanaryWork(issue);
        await expect(rollbackAutonomousDeployment(canary.id, 'x', { repoRoot, reloadPath })).rejects.toThrow('has not been deployed');
    }, 30_000);

    test('persists a terminal rolled_back state (never leaves canary / retries the same revert) when the revert lands but the reverted tree itself fails the post-revert gate', async () => {
        const issue = developmentIssue({ fingerprint: 'rollback-gate-fails-issue' });
        const canary = await buildCanaryWork(issue);
        const deployed = await deployAutonomousMaintenanceWork(canary.id, { repoRoot, reloadPath });
        const headAfterDeploy = currentHead();

        // Something lands on top of the deploy afterward that makes the
        // *reverted* tree itself fail baseline checks (independent of the
        // revert's own mechanics succeeding cleanly).
        writeFileSync(join(repoRoot, '.should-fail-gate'), '1');
        run(['git', 'add', '-A']);
        run(['git', 'commit', '-q', '-m', 'a later commit that breaks the baseline, unrelated to whether the revert itself applies cleanly']);

        const rolledBack = await rollbackAutonomousDeployment(deployed.id, 'manual rollback for test', { repoRoot, reloadPath });

        // The revert itself genuinely landed - never repeat it, and never
        // leave this maintenance work sitting in 'canary' for the next
        // scan to retry an identical revert against an identical,
        // still-broken tree.
        expect(rolledBack.status).toBe('rolled_back');
        expect(rolledBack.rollbackReason).toContain('post-revert full gate failed');
        expect(currentHead()).not.toBe(headAfterDeploy); // the revert commit really was created

        const issueAfter = getIssue(issue.id);
        expect(issueAfter?.status).toBe('failed'); // development-owned failed for retry/diagnosis, never left canary
        expect(issueAfter?.ownerLayer).toBe('development');
        expect(issueAfter?.nextRetryAt).toBeGreaterThan(Date.now());

        // A reload is still requested - the live checkout's code genuinely changed.
        expect(getDeploymentReloadState(reloadPath).generation).toBeGreaterThan(0);
    }, 30_000);
});
