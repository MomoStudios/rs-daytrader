// DayTrader - Pinned Full Verification Gate
//
// The mandatory pre-commit/pre-deploy verification gate every autonomous
// repair (worker, deployer, rollback) must pass before the deterministic
// host ever trusts it: typecheck every tsconfig project, then run the full
// test suite. This is a fixed, immutable sequence of argv commands defined
// here, in currently-running host code - it is NEVER resolved from
// `package.json`'s `scripts` field (unlike the old `bun run check`). An
// autonomous patch that rewrites `package.json` (its "check"/"test"/
// "typecheck*" scripts, or anything else) therefore cannot change what
// this gate actually runs: the host process that invokes the gate already
// has this exact sequence loaded into memory from its own source, not from
// the working tree the patch modified.
//
// The `tsc` binary itself always comes from a stable "tool root" checkout
// that is guaranteed to have `node_modules` installed (the real repository
// root) - even when the code actually being verified lives in a freshly
// created, ephemeral git worktree that has no `node_modules` of its own.
// Only the *working directory* (and therefore which tsconfig.json/which
// source and test files get exercised) points at the code under test.
//
// This module only builds/runs the fixed argv sequence itself; every call
// site (autonomousWorkerRunner.ts, autonomousDeployment.ts) wraps the
// spawn function it passes to runPinnedGate in a real bubblewrap sandbox
// (see bwrapSandbox.ts) before ever executing a step here - no network, no
// real HOME, no live-repository mount beyond the target
// worktree/node_modules/Bun binary. Deploy/rollback verification never
// even points this gate at the live checkout: it runs against a
// disposable, detached git worktree at the exact deployed/reverted
// revision instead (see autonomousDeployment.ts's
// verifyRevisionInDisposableWorktree).
//
// Residual trust (read this before assuming the gate is a complete
// sandbox): this still *executes* the target checkout's own source and
// test files with a real TypeScript compiler and a real test runner,
// necessarily now inside that bubblewrap sandbox rather than unconfined. A
// patch cannot change *which* commands run, or run them with elevated
// privileges/credentials/network access (see workerContract.ts's
// buildRestrictedEnv - no bot credentials, no arbitrary env, a fixed git
// identity), but it *can* still influence what those pinned commands
// observe, simply by being the code they compile and execute inside the
// sandbox. That is an intentional, accepted, and necessary trust boundary
// - a fix cannot be verified without running it - and it is exactly why
// the diff/path/secret policy gate (isDeployPathAllowed,
// validateAutonomousChange) always runs BEFORE this gate, not after:
// known-dangerous paths and obvious secret-shaped content are rejected
// before a single pinned command ever executes a byte of the patch, and
// the post-gate diff is independently re-inspected/re-reviewed afterward
// (see autonomousWorkerRunner.ts) since the gate itself had read-write
// access to the worktree while it ran.

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface PinnedGateStep {
    label: string;
    argv: string[];
}

/**
 * Repo-relative test directories every gate run must cover. Mirrors
 * `package.json`'s own "test" script as of when this policy was authored,
 * but - unlike that script - is fixed here independently of it: rewriting
 * `package.json` never changes what this list contains.
 */
const FIXED_TEST_DIRS = [
    'sdk/test',
    'server/webclient/src/bot',
    'server/webclient/src/util',
    'server/webclient/src/lite',
    'bots/DayTrader/test',
];

/**
 * Builds the real, production pinned gate: three `tsc --noEmit`
 * invocations (root, webclient, DayTrader projects) followed by the full
 * `bun test` suite over a fixed set of existing repo-relative directories.
 *
 * @param toolRoot A checkout guaranteed to have `node_modules` installed
 *   (the stable repository root) - this is where the `tsc` binary and the
 *   `bun`/node executable resolution come from, regardless of where the
 *   code under test lives.
 * @param workingRoot The directory whose code is actually being verified:
 *   an isolated worktree for the autonomous worker, or the live checkout
 *   for deploy/rollback. Defaults to `toolRoot` when they are the same
 *   (deploy/rollback always verify the live checkout in place).
 */
export function buildPinnedGateSteps(toolRoot: string, workingRoot: string = toolRoot): PinnedGateStep[] {
    const tsc = join(toolRoot, 'node_modules', '.bin', 'tsc');
    if (!existsSync(tsc)) {
        throw new Error(`Pinned gate cannot find the tsc binary at a fixed path: ${tsc}`);
    }
    const existingTestDirs = FIXED_TEST_DIRS.filter(dir => existsSync(join(workingRoot, dir)));
    if (existingTestDirs.length === 0) {
        throw new Error(`Pinned gate found none of its fixed test directories under '${workingRoot}'`);
    }
    return [
        { label: 'typecheck (root)', argv: [tsc, '--noEmit'] },
        {
            label: 'typecheck (webclient)',
            argv: [tsc, '--noEmit', '-p', join(workingRoot, 'server', 'webclient', 'tsconfig.json')],
        },
        {
            label: 'typecheck (DayTrader)',
            argv: [tsc, '--noEmit', '-p', join(workingRoot, 'bots', 'DayTrader', 'tsconfig.json')],
        },
        { label: 'test suite', argv: [process.execPath, 'test', ...existingTestDirs] },
    ];
}

let overrideSteps: PinnedGateStep[] | null = null;

/**
 * Test-only hook: replace the pinned gate with a fixture-appropriate
 * sequence (e.g. a scratch repo's own fast pass/fail script) so tests
 * never need a real, fully-buildable TypeScript project or the full
 * production test suite. Never called from production code paths, and
 * never reachable by the autonomous agent - only this process's own test
 * harness (a trusted call site) can invoke it. Pass `null` to restore the
 * real pinned production sequence.
 */
export function _setPinnedGateStepsForTests(steps: PinnedGateStep[] | null): void {
    overrideSteps = steps;
}

/** Resolves the gate steps to run: the test override if one is set, else the real pinned production sequence. */
export function resolvePinnedGateSteps(toolRoot: string, workingRoot: string = toolRoot): PinnedGateStep[] {
    return overrideSteps ?? buildPinnedGateSteps(toolRoot, workingRoot);
}

export interface GateRunResult {
    success: boolean;
    stdout: string;
    stderr: string;
    failedStep: string | null;
}

export type GateSpawnFn = (
    argv: string[],
    opts: { cwd: string; env: Record<string, string>; timeoutMs: number }
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

/**
 * Runs every pinned gate step in order against `cwd`, stopping at (and
 * reporting) the first failure. Never short-circuits based on trusting any
 * prior claim about the code - every step actually executes.
 */
export async function runPinnedGate(
    spawnFn: GateSpawnFn,
    steps: PinnedGateStep[],
    cwd: string,
    envVars: Record<string, string>,
    timeoutMsPerStep: number
): Promise<GateRunResult> {
    // DayTrader tests allocate isolated SQLite/JSON fixtures beneath this
    // ignored runtime directory. A fresh git worktree does not contain empty
    // ignored directories, so prepare the mount point deterministically
    // before entering the sandbox.
    if (existsSync(cwd)) {
        mkdirSync(join(cwd, 'bots', 'DayTrader', 'data'), { recursive: true });
    }
    let stdout = '';
    let stderr = '';
    for (const step of steps) {
        const result = await spawnFn(step.argv, { cwd, env: envVars, timeoutMs: timeoutMsPerStep });
        stdout += `\n--- ${step.label} ---\n${result.stdout}`;
        stderr += `\n--- ${step.label} ---\n${result.stderr}`;
        if (!result.success) {
            return { success: false, stdout, stderr, failedStep: step.label };
        }
    }
    return { success: true, stdout, stderr, failedStep: null };
}
