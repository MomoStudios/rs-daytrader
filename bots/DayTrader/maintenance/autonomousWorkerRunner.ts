// DayTrader - Isolated Autonomous Development Worker
//
// The generic fallback for every development-owned technical issue that has
// no deterministic recipe (see maintenance/workerContract.ts for the fast
// path): claims a maintenance_work row, builds an isolated git worktree,
// runs the tool-enabled AutonomousDevelopmentAgent against exactly one
// issue, and independently re-validates everything the agent claims before
// anything reaches `canary`. No LLM output is ever trusted at face value:
// - the agent's outcome label is cross-checked against the *actual* git
//   diff, never taken on its own - and every git inspection command
//   (status/diff/numstat) that fails outright is itself treated as a
//   failure requiring a bounded retry, never silently read as "no changes"
//   or an empty valid diff;
// - every changed/staged path is validated against a broad repo policy
//   (secrets/runtime data/vendored keys/generated dependency trees are
//   always rejected, regardless of what the agent touched);
// - the patch size is bounded and binary/secret-shaped diffs are rejected;
// - a change touching a "protected path" (package.json/lockfiles, or any
//   file that is itself part of this autonomous control plane - see
//   protectedPaths.ts) must additionally pass a deterministic
//   prompt-injection scan and then a quorum of independent, fresh, tool-free
//   AutonomousPatchReviewer sessions (autonomousPatchReviewer.ts) - every
//   diff/path handed to those sessions is treated as untrusted content, not
//   instructions - unanimous approval required, before it may ever be
//   committed;
// - the pinned full verification gate (pinnedGate.ts - a fixed argv
//   sequence defined in this currently-running host code, never resolved
//   from the checkout's own `package.json`) is run by this deterministic
//   host, never trusted from the agent's own claims, before any commit;
// - only this host ever runs `git commit` - the agent can only inspect git
//   state (see autonomousPermissionHandler.ts).
//
// Residual trust: the pinned gate still *executes* the patch's own source
// and test files with a real compiler/test runner - a fix cannot be
// verified without running it. What is actually pinned is which commands
// run and in what environment (see pinnedGate.ts's own doc comment for the
// full accounting), and that is checked only after the path/secret/size
// policy (and, for protected paths, independent review) already passed.
//
// This does not deploy: a successful run reaches `canary` with a real
// commit on an isolated branch. Deployment (cherry-pick into the live
// checkout), the post-deploy observation window, and rollback live in
// autonomousDeployment.ts.

import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
    transitionIssue,
    DEVELOPMENT_ELIGIBLE_CATEGORIES,
    type IssueRecord,
} from '../lib/issueRegistry';
import {
    claimMaintenanceWork,
    getMaintenanceWork,
    proposeMaintenanceWork,
    transitionMaintenanceWork,
    type MaintenanceWorkRecord,
} from '../lib/maintenanceStore';
import { buildRestrictedEnv } from './workerContract';
import { defaultSpawn, type SpawnFn } from './isolatedWorkerRunner';
import { getDevelopmentState } from '../lib/developmentStore';
import { computeRegistryMetrics } from '../lib/registryMetrics';
import {
    AutonomousDevelopmentAgent,
    buildAutonomousDevelopmentPrompt,
    defaultAutonomousBaseDirectory,
} from '../lib/autonomousDevelopmentAgent';
import { assessDirectionRequestCredibility, type AutonomousAgentResult } from '../lib/autonomousAgentSchema';
import {
    defaultPatchReviewFn,
    defaultPatchReviewBaseDirectory,
    defaultPatchReviewQuorumFn,
    findPromptInjectionIndicators,
    type PatchReviewFn,
    type PatchReviewQuorumFn,
} from '../lib/autonomousPatchReviewer';
import { anyProtectedPathTouched, listProtectedPaths } from './protectedPaths';
import { computeNextRetryAt } from './autonomousRetryPolicy';
import { resolvePinnedGateSteps, runPinnedGate } from './pinnedGate';
import { defaultSandboxSpawnFactory, type SandboxSpawnFactory } from './bwrapSandbox';
import { log } from '../lib/logger';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname, '..', '..', '..');
const DEFAULT_WORKTREE_PARENT = join(__dirname, '..', 'data', 'autonomous-worktrees');
const DEFAULT_GATE_TIMEOUT_MS = 15 * 60_000;

/** The recipeId used for every generic autonomous repair attempt (never a fixed deterministic recipe). */
export const AUTONOMOUS_RECIPE_ID = 'autonomous-development';

/**
 * The exact five technical categories the autonomous development layer is
 * responsible for. Everything else (escalation, workflow, reservation_
 * violation, transient_fault) is handled by its own owning layer/mechanism
 * and is never picked up here. Re-exported from issueRegistry.ts (the
 * canonical, dependency-free definition) so other modules - including
 * registryMetrics.ts, which this module itself depends on - can reference
 * it without creating an import cycle.
 */
export { DEVELOPMENT_ELIGIBLE_CATEGORIES };

export const ARCHITECTURE_BOUNDARIES_SUMMARY = [
    'Strategist/operator/development-reviewer LLMs are tool-free; only this autonomous coding agent (confined to one isolated worktree) and the deterministic host may touch the filesystem or git.',
    'The deterministic host - never the agent - owns git commit/push/deploy; the agent may only inspect git state (status/diff/log/show/rev-parse).',
    'Runtime data (bots/*/data/**), bot.env/.env, credentials, and private keys are out of bounds for reads and writes alike.',
    'The agent cannot run bun, tsc, or any other interpreter/build/test-runner command itself - its shell tool is a small allowlist of genuinely read-only local inspection commands and none of them execute project code.',
    'A change must pass the pinned full verification gate (typecheck + the full test suite), run by the deterministic host inside a bubblewrap sandbox (no network, no real HOME, no live-repository access beyond the code under test and a read-only shared node_modules) before it can be committed, and again (in a disposable sandboxed worktree, never the live checkout) after deployment, before it is trusted. Changes to package.json/lockfiles or the autonomous control plane itself additionally require a separate independent patch review before they can be committed.',
].join(' ');

// ---------------------------------------------------------------------------
// Pure change-validation helpers
// ---------------------------------------------------------------------------

const DEPLOY_BLOCKED_PATH_PATTERNS: RegExp[] = [
    /(^|\/)\.git(\/|$)/,
    /(^|\/)node_modules(\/|$)/,
    /(^|\/)bot\.env$/,
    /(^|\/)\.env(\.[^/]*)?$/,
    // Any bot's runtime data directory, not just DayTrader's.
    /(^|\/)bots\/[^/]+\/data(\/|$)/,
    // Vendored/generated dependency trees.
    /(^|\/)server\/vendor(\/|$)/,
    /credentials?(\/|\.|$)/i,
    /\.pem$/i,
    /id_(rsa|dsa|ecdsa|ed25519)(\.[^/]*)?$/i,
    /private[-_]?key/i,
    /(^|\/)\.ssh(\/|$)/,
    /(^|\/)\.aws(\/|$)/,
];

/** Broad allow-by-default repo policy: allow code/docs/config, block secrets/runtime/generated/vendored keys. */
export function isDeployPathAllowed(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!normalized) return false;
    return !DEPLOY_BLOCKED_PATH_PATTERNS.some(pattern => pattern.test(normalized));
}

export interface ChangeSummary {
    files: string[];
    insertions: number;
    deletions: number;
    binaryFiles: string[];
}

/** Parses `git diff --numstat` output. Binary files report `-` for both counts. */
export function parseNumstat(output: string): ChangeSummary {
    const files: string[] = [];
    const binaryFiles: string[] = [];
    let insertions = 0;
    let deletions = 0;
    for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split('\t');
        if (parts.length < 3) continue;
        const [insText, delText, path] = parts as [string, string, string];
        files.push(path);
        if (insText === '-' || delText === '-') {
            binaryFiles.push(path);
            continue;
        }
        insertions += Number(insText) || 0;
        deletions += Number(delText) || 0;
    }
    return { files, insertions, deletions, binaryFiles };
}

const SECRET_CONTENT_PATTERNS: RegExp[] = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /AKIA[0-9A-Z]{16}/, // AWS access key id
    /gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
    /xox[baprs]-[0-9A-Za-z-]{10,}/, // Slack tokens
    /AIza[0-9A-Za-z\-_]{35}/, // Google API key
];

export interface ChangeLimits {
    maxFiles: number;
    maxChangedLines: number;
}

export const DEFAULT_CHANGE_LIMITS: ChangeLimits = { maxFiles: 30, maxChangedLines: 5_000 };

export interface ChangeValidation {
    ok: boolean;
    reason?: string;
}

/**
 * The full, deterministic gate a diff must pass before it is ever staged
 * or committed: non-empty, bounded size, no binary files, every path
 * inside the broad repo policy, and no obvious secret/credential content.
 */
export function validateAutonomousChange(
    summary: ChangeSummary,
    diffText: string,
    limits: ChangeLimits = DEFAULT_CHANGE_LIMITS
): ChangeValidation {
    if (summary.files.length === 0) return { ok: false, reason: 'no changed files' };
    if (summary.files.length > limits.maxFiles) {
        return { ok: false, reason: `too many changed files (${summary.files.length} > ${limits.maxFiles})` };
    }
    const totalLines = summary.insertions + summary.deletions;
    if (totalLines > limits.maxChangedLines) {
        return { ok: false, reason: `patch too large (${totalLines} changed lines > ${limits.maxChangedLines})` };
    }
    if (summary.binaryFiles.length > 0) {
        return { ok: false, reason: `binary file changes are not allowed: ${summary.binaryFiles.join(', ')}` };
    }
    for (const path of summary.files) {
        if (!isDeployPathAllowed(path)) {
            return { ok: false, reason: `changed path is outside the allowed repository policy: ${path}` };
        }
    }
    for (const pattern of SECRET_CONTENT_PATTERNS) {
        if (pattern.test(diffText)) {
            return { ok: false, reason: 'diff appears to contain a secret/credential pattern' };
        }
    }
    return { ok: true };
}

/** Issue-linked commit message with the repository's standard Copilot trailer. */
export function buildAutonomousCommitMessage(
    issue: Pick<IssueRecord, 'id' | 'title' | 'category' | 'severity'>,
    result: Pick<AutonomousAgentResult, 'summary' | 'outcome'>
): string {
    const scope = issue.category.replace(/_/g, '-');
    const subject = `fix(${scope}): ${issue.title}`.slice(0, 100);
    return [
        subject,
        '',
        `Issue: ${issue.id} (category=${issue.category}, severity=${issue.severity})`,
        `Outcome: ${result.outcome}`,
        result.summary,
        '',
        'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>',
    ].join('\n');
}

/**
 * Runs the pinned full verification gate (see pinnedGate.ts) against
 * `workingRoot`, using `toolRoot` (always the stable repository checkout)
 * to resolve the `tsc` binary/`node_modules`. Never resolves anything from
 * the (possibly agent-modified) `package.json` in `workingRoot`.
 *
 * The worker's own isolated worktree (`workingRoot`) is exactly what gets
 * sandboxed (see bwrapSandbox.ts): mounted read-write at `/workspace` -
 * the only thing the gate's sandboxed commands may ever mutate - with
 * `toolRoot`'s `node_modules` mounted read-only alongside it (the isolated
 * worktree has none of its own) and no network/real-HOME/live-repo access
 * at all.
 */
async function runFullGate(
    spawnFn: SpawnFn,
    toolRoot: string,
    workingRoot: string,
    env: Record<string, string>,
    timeoutMsPerStep: number,
    sandboxSpawnFactory: SandboxSpawnFactory
): Promise<{ success: boolean; stdout: string; stderr: string }> {
    const steps = resolvePinnedGateSteps(toolRoot, workingRoot);
    const sandboxedSpawn = sandboxSpawnFactory(spawnFn, {
        workspaceRealPath: workingRoot,
        toolNodeModulesRealPath: join(toolRoot, 'node_modules'),
        bunExecutableRealPath: process.execPath,
        additionalReadOnlyMounts: [
            {
                realPath: join(toolRoot, 'server', 'webclient', 'node_modules'),
                sandboxPath: '/workspace/server/webclient/node_modules',
            },
        ],
    });
    return runPinnedGate(sandboxedSpawn, steps, workingRoot, env, timeoutMsPerStep);
}

// ---------------------------------------------------------------------------
// Agent execution (injectable for tests)
// ---------------------------------------------------------------------------

export type AgentRunFn = (input: {
    worktreePath: string;
    baseDirectory: string;
    prompt: string;
}) => Promise<AutonomousAgentResult>;

/** Real agent execution: start a fresh isolated session, run once, always stop. */
export const defaultAgentRun: AgentRunFn = async ({ worktreePath, baseDirectory, prompt }) => {
    const agent = new AutonomousDevelopmentAgent({
        worktreePath,
        baseDirectory,
        onPermissionDecision: entry => {
            if (!entry.allowed) {
                log('development_error', {
                    stage: 'autonomous_permission_denied',
                    kind: entry.kind,
                    reason: entry.reason,
                });
            }
        },
        onToolAudit: entry => log('note', { msg: 'autonomous agent tool call', ...entry }),
    });
    try {
        await agent.start();
        return await agent.run(prompt);
    } finally {
        await agent.stop();
    }
};

function findRelatedReviewSummary(reviewId: string | null): string | null {
    if (!reviewId) return null;
    return getDevelopmentState().reviews.find(review => review.id === reviewId)?.review.summary ?? null;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunAutonomousMaintenanceWorkOptions {
    repoRoot?: string;
    worktreeParentDir?: string;
    spawn?: SpawnFn;
    agentRun?: AgentRunFn;
    gateTimeoutMs?: number;
    changeLimits?: ChangeLimits;
    now?: () => number;
    /**
     * Independent patch reviewer invoked only when a change touches a
     * protected path (see protectedPaths.ts). Defaults to
     * `defaultPatchReviewFn` (a real, separate Copilot session) in
     * production; tests always inject their own mock here - no test ever
     * makes a real model call for this. Invoked `REQUIRED_PATCH_REVIEW_QUORUM`
     * independent times per protected-path check - see `patchReviewQuorum`.
     */
    patchReview?: PatchReviewFn;
    /**
     * Combines `REQUIRED_PATCH_REVIEW_QUORUM` independent `patchReview`
     * invocations into a single unanimous-or-reject verdict for a
     * protected-path change (see autonomousPatchReviewer.ts). Defaults to
     * `defaultPatchReviewQuorumFn`; injectable purely so tests can swap in
     * a smaller/instrumented quorum without needing several real reviewer
     * calls.
     */
    patchReviewQuorum?: PatchReviewQuorumFn;
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

async function failForRetry(
    work: MaintenanceWorkRecord,
    issue: IssueRecord,
    reason: string,
    now: () => number,
    repoRoot: string,
    branchName: string,
    spawnFn: SpawnFn,
    env: Record<string, string>
): Promise<MaintenanceWorkRecord> {
    // `issue` is the caller-captured snapshot from before this repair
    // attempt's own `transitionIssue({status:'repairing', incrementAttempts:
    // true})` call (see runAutonomousMaintenanceWork) - its `.attempts` is
    // one behind the current database value by the time any failure path
    // reaches here. Using `issue.attempts + 1` (rather than the stale
    // `issue.attempts`) is what makes the exponential backoff actually
    // escalate across repeated failures of the same issue, instead of
    // computing the exact same wait every time.
    const nextRetryAt = computeNextRetryAt(issue.attempts + 1, now());
    transitionMaintenanceWork({ id: work.id, status: 'failed', rollbackReason: reason });
    transitionIssue({ id: issue.id, status: 'failed', resolutionEvidence: reason, nextRetryAt });
    await spawnFn(['git', 'branch', '-D', branchName], { cwd: repoRoot, env, timeoutMs: 15_000 }).catch(() => undefined);
    log('maintenance_work', { workId: work.id, issueId: issue.id, recipeId: AUTONOMOUS_RECIPE_ID, status: 'failed', reason, nextRetryAt });
    const record = getMaintenanceWork(work.id);
    if (!record) throw new Error(`maintenance work '${work.id}' vanished after failure`);
    return record;
}

async function requireDirection(
    work: MaintenanceWorkRecord,
    issue: IssueRecord,
    result: AutonomousAgentResult,
    repoRoot: string,
    branchName: string,
    spawnFn: SpawnFn,
    env: Record<string, string>
): Promise<MaintenanceWorkRecord> {
    const reason = `[${result.directionKind}] ${result.humanQuestion ?? result.summary}`;
    transitionMaintenanceWork({ id: work.id, status: 'rejected', rollbackReason: reason });
    transitionIssue({ id: issue.id, status: 'deferred', ownerLayer: 'human', resolutionEvidence: reason });
    await spawnFn(['git', 'branch', '-D', branchName], { cwd: repoRoot, env, timeoutMs: 15_000 }).catch(() => undefined);
    log('maintenance_work', {
        workId: work.id,
        issueId: issue.id,
        recipeId: AUTONOMOUS_RECIPE_ID,
        status: 'rejected',
        ownerLayer: 'human',
        directionKind: result.directionKind,
        humanQuestion: result.humanQuestion,
    });
    const record = getMaintenanceWork(work.id);
    if (!record) throw new Error(`maintenance work '${work.id}' vanished after requires_direction`);
    return record;
}

export interface PolicyAndReviewResult {
    ok: boolean;
    reason?: string;
}

/**
 * The full path/secret/size policy gate (validateAutonomousChange) plus,
 * when a protected path is touched, the independent patch review - both
 * against the given (already-fetched) change summary/diff text. Shared by
 * the pre-gate check and the post-gate re-check (see the "worktree changed
 * during the sandboxed gate run" handling in runAutonomousMaintenanceWork)
 * so both stages apply byte-for-byte the same policy, never a weaker one
 * the second time around.
 */
async function validateAndReviewChange(
    issue: IssueRecord,
    work: MaintenanceWorkRecord,
    changeSummary: ChangeSummary,
    diffText: string,
    changeLimits: ChangeLimits,
    patchReviewFn: PatchReviewFn,
    patchReviewQuorumFn: PatchReviewQuorumFn,
    repoRoot: string,
    stage: 'pre-gate' | 'post-gate'
): Promise<PolicyAndReviewResult> {
    const validation = validateAutonomousChange(changeSummary, diffText, changeLimits);
    if (!validation.ok) {
        return { ok: false, reason: `change rejected by policy gate (${stage}): ${validation.reason}` };
    }
    const protectedTouched = listProtectedPaths(changeSummary.files);
    if (anyProtectedPathTouched(changeSummary.files)) {
        // Deterministic, bounded scan for reviewer-directed prompt-injection
        // indicators in the patch's own added lines - runs before any model
        // call at all, and on a match alone is enough to fail this
        // protected-path change for a bounded retry (see
        // autonomousPatchReviewer.ts's findPromptInjectionIndicators).
        const injectionIndicators = findPromptInjectionIndicators(diffText);
        if (injectionIndicators.length > 0) {
            return {
                ok: false,
                reason:
                    `deterministic prompt-injection scan flagged a protected-path change (${stage}) (${protectedTouched.join(', ')}) ` +
                    `before any model review ran: ${injectionIndicators.join('; ')}`,
            };
        }
        let review;
        try {
            review = await patchReviewQuorumFn(patchReviewFn, {
                issueId: issue.id,
                changedPaths: changeSummary.files,
                diff: diffText,
                baseDirectory: defaultPatchReviewBaseDirectory(repoRoot, work.id),
            });
        } catch (error) {
            return {
                ok: false,
                reason: `independent patch review could not be completed for a protected-path change (${stage}) (${protectedTouched.join(', ')}): ${String(error)}`,
            };
        }
        if (!review.approved) {
            return {
                ok: false,
                reason: `independent patch review rejected a protected-path change (${stage}) (${protectedTouched.join(', ')}): ${review.summary} (${review.findings.join('; ')})`,
            };
        }
        log('note', {
            msg: `independent patch review quorum approved a protected-path change (${stage})`,
            issueId: issue.id,
            protectedPaths: protectedTouched,
            reviewSummary: review.summary,
        });
    }
    return { ok: true };
}

/**
 * Runs one autonomous repair attempt against one development-owned
 * technical issue end to end: isolated worktree -> agent run -> independent
 * git-state inspection -> (already-resolved fast path | mandatory
 * validate+review+gate+commit) -> canary. Never commits without a passing
 * pinned verification gate (and, for protected-path changes, an approving
 * independent patch review); never trusts the agent's outcome label
 * without cross-checking the actual diff.
 */
export async function runAutonomousMaintenanceWork(
    issue: IssueRecord,
    options: RunAutonomousMaintenanceWorkOptions = {}
): Promise<MaintenanceWorkRecord> {
    if (issue.ownerLayer !== 'development') {
        throw new Error(
            `Autonomous development repair only runs against development-owned issues; '${issue.id}' is owned by '${issue.ownerLayer}'`
        );
    }
    if (!DEVELOPMENT_ELIGIBLE_CATEGORIES.includes(issue.category)) {
        throw new Error(`Autonomous development repair is not eligible for issue category '${issue.category}'`);
    }

    const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
    const worktreeParentDir = options.worktreeParentDir ?? DEFAULT_WORKTREE_PARENT;
    const spawnFn = options.spawn ?? defaultSpawn;
    const agentRun = options.agentRun ?? defaultAgentRun;
    const gateTimeoutMs = options.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    const changeLimits = options.changeLimits ?? DEFAULT_CHANGE_LIMITS;
    const patchReviewFn = options.patchReview ?? defaultPatchReviewFn;
    const patchReviewQuorumFn = options.patchReviewQuorum ?? defaultPatchReviewQuorumFn;
    const sandboxSpawnFactory = options.sandboxSpawnFactory ?? defaultSandboxSpawnFactory;
    const now = options.now ?? (() => Date.now());

    const isolatedHome = join(worktreeParentDir, '.home');
    mkdirSync(isolatedHome, { recursive: true });
    const restrictedEnv = buildRestrictedEnv(process.env, isolatedHome);

    const proposed = proposeMaintenanceWork(issue.id, AUTONOMOUS_RECIPE_ID);
    const claimed = claimMaintenanceWork(proposed.id);
    if (!claimed) {
        throw new Error(`Autonomous maintenance work '${proposed.id}' is already ${proposed.status}; another worker owns it`);
    }
    let work = claimed;
    transitionIssue({ id: issue.id, status: 'repairing', incrementAttempts: true });

    mkdirSync(worktreeParentDir, { recursive: true });
    const branchName = `autonomous-dev/${work.id}`;
    const worktreePath = join(worktreeParentDir, work.id);

    const addWorktree = await spawnFn(['git', 'worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], {
        cwd: repoRoot,
        env: restrictedEnv,
        timeoutMs: 30_000,
    });
    if (!addWorktree.success) {
        return failForRetry(
            work,
            issue,
            `failed to create isolated worktree: ${addWorktree.stderr.slice(-1000)}`,
            now,
            repoRoot,
            branchName,
            spawnFn,
            restrictedEnv
        );
    }
    work = transitionMaintenanceWork({ id: work.id, status: 'running', worktreePath, branchName });

    try {
        const baseDirectory = defaultAutonomousBaseDirectory(repoRoot, work.id);
        const relatedReviewSummary = findRelatedReviewSummary(issue.relatedReviewId);
        const prompt = buildAutonomousDevelopmentPrompt({
            issueId: issue.id,
            category: issue.category,
            severity: issue.severity,
            title: issue.title,
            description: issue.description,
            evidence: issue.evidence,
            attempts: issue.attempts,
            recurrenceCount: issue.recurrenceCount,
            relatedReviewSummary,
            architectureBoundaries: ARCHITECTURE_BOUNDARIES_SUMMARY,
            recentSystemMetrics: computeRegistryMetrics(),
        });

        let result: AutonomousAgentResult;
        try {
            result = await agentRun({ worktreePath, baseDirectory, prompt });
        } catch (error) {
            return await failForRetry(
                work,
                issue,
                `autonomous agent run failed: ${String(error)}`,
                now,
                repoRoot,
                branchName,
                spawnFn,
                restrictedEnv
            );
        }

        if (result.outcome === 'requires_direction') {
            // A well-formed requires_direction outcome is not automatically
            // trusted: it must also be *credible* (its directionKind must
            // plausibly match its own humanQuestion/summary). Anything
            // else - malformed, or a directionKind that reads like
            // ordinary technical uncertainty wearing a credentials/
            // authorization/policy label to dodge the "keep retrying"
            // instruction - is treated as an ordinary technical failure
            // and stays development-owned for a bounded retry, never
            // silently handed to a human.
            const credibility = assessDirectionRequestCredibility(result);
            if (!credibility.ok) {
                return await failForRetry(
                    work,
                    issue,
                    `requires_direction outcome rejected as not credible (${credibility.reason}); treated as an ordinary technical failure`,
                    now,
                    repoRoot,
                    branchName,
                    spawnFn,
                    restrictedEnv
                );
            }
            return await requireDirection(work, issue, result, repoRoot, branchName, spawnFn, restrictedEnv);
        }

        // Never trust the outcome label alone - inspect the actual worktree.
        // A failed `git status` here must never be misread as "no changes"
        // (which would fall through to the already_resolved/promoted fast
        // path below) - it is an inspection failure and must fail for a
        // bounded retry instead.
        const status = await spawnFn(['git', 'status', '--porcelain'], {
            cwd: worktreePath,
            env: restrictedEnv,
            timeoutMs: 15_000,
        });
        if (!status.success) {
            return await failForRetry(
                work,
                issue,
                `could not independently inspect the worktree ('git status' failed): ${status.stderr.slice(-1000)}`,
                now,
                repoRoot,
                branchName,
                spawnFn,
                restrictedEnv
            );
        }
        const hasChanges = status.stdout.trim().length > 0;

        if (result.outcome === 'failed' || !hasChanges) {
            if (result.outcome === 'failed') {
                return await failForRetry(work, issue, result.summary, now, repoRoot, branchName, spawnFn, restrictedEnv);
            }
            // outcome is 'resolved'/'already_resolved' but nothing actually
            // changed - independently verify the claim against the current
            // checkout rather than trusting it.
            const gate = await runFullGate(spawnFn, repoRoot, worktreePath, restrictedEnv, gateTimeoutMs, sandboxSpawnFactory);
            if (!gate.success) {
                return await failForRetry(
                    work,
                    issue,
                    `agent reported ${result.outcome} but the independent full gate failed on the current checkout: ${gate.stderr.slice(-1000)}`,
                    now,
                    repoRoot,
                    branchName,
                    spawnFn,
                    restrictedEnv
                );
            }
            await spawnFn(['git', 'branch', '-D', branchName], { cwd: repoRoot, env: restrictedEnv, timeoutMs: 15_000 }).catch(() => undefined);
            const promoted = transitionMaintenanceWork({
                id: work.id,
                status: 'promoted',
                testOutput: gate.stdout.slice(-4000),
                canaryOutcome: JSON.stringify({ alreadyResolved: true, verifiedAt: now() }),
            });
            transitionIssue({
                id: issue.id,
                status: 'resolved',
                resolutionEvidence: `${result.summary} (independently verified via full gate; no code change needed)`,
            });
            log('maintenance_work', {
                workId: promoted.id,
                issueId: issue.id,
                recipeId: AUTONOMOUS_RECIPE_ID,
                status: 'promoted',
                alreadyResolved: true,
            });
            return promoted;
        }

        // hasChanges: stage first so untracked new files are visible to
        // `git diff --cached` (an unstaged diff never shows brand-new
        // files), then mandatory validate -> gate -> commit -> canary.
        const add = await spawnFn(['git', 'add', '-A'], { cwd: worktreePath, env: restrictedEnv, timeoutMs: 15_000 });
        if (!add.success) {
            return await failForRetry(work, issue, `git add failed: ${add.stderr.slice(-1000)}`, now, repoRoot, branchName, spawnFn, restrictedEnv);
        }
        const numstat = await spawnFn(['git', 'diff', '--cached', '--no-renames', '--numstat'], { cwd: worktreePath, env: restrictedEnv, timeoutMs: 15_000 });
        const diff = await spawnFn(['git', 'diff', '--cached', '--no-renames'], { cwd: worktreePath, env: restrictedEnv, timeoutMs: 15_000 });
        // A failed `git diff`/`--numstat` must never be silently parsed as
        // an empty (and therefore trivially "valid") diff - that would
        // either wrongly reject via validateAutonomousChange's "no changed
        // files" branch by accident, or worse, mask a real but
        // inconsistently-reported change. Fail explicitly for retry.
        if (!numstat.success || !diff.success) {
            return await failForRetry(
                work,
                issue,
                `could not independently inspect the staged change ('git diff' failed): ${numstat.stderr.slice(-500)} ${diff.stderr.slice(-500)}`.trim(),
                now,
                repoRoot,
                branchName,
                spawnFn,
                restrictedEnv
            );
        }
        const changeSummary = parseNumstat(numstat.stdout);
        // The full path/secret/size policy gate, plus (when a protected
        // path is touched) the independent patch review - see
        // protectedPaths.ts and autonomousPatchReviewer.ts. This is never
        // downgraded to "ask a human": a rejection (or a reviewer that
        // itself fails to complete) is treated exactly like any other
        // technical failure - the issue stays development-owned for a
        // bounded automatic retry.
        const preGateReview = await validateAndReviewChange(
            issue,
            work,
            changeSummary,
            diff.stdout,
            changeLimits,
            patchReviewFn,
            patchReviewQuorumFn,
            repoRoot,
            'pre-gate'
        );
        if (!preGateReview.ok) {
            return await failForRetry(work, issue, preGateReview.reason ?? 'pre-gate review rejected the change', now, repoRoot, branchName, spawnFn, restrictedEnv);
        }

        const gate = await runFullGate(spawnFn, repoRoot, worktreePath, restrictedEnv, gateTimeoutMs, sandboxSpawnFactory);
        transitionMaintenanceWork({
            id: work.id,
            status: gate.success ? 'tested' : 'failed',
            testOutput: `${gate.stdout}\n${gate.stderr}`.slice(-4000),
        });
        if (!gate.success) {
            return await failForRetry(
                work,
                issue,
                `mandatory pinned verification gate failed: ${gate.stderr.slice(-1000)}`,
                now,
                repoRoot,
                branchName,
                spawnFn,
                restrictedEnv
            );
        }

        // The sandboxed gate just executed the patch's own (possibly
        // untrusted) source/test files with read-write access to this
        // worktree. Never assume the index staged before the gate ran is
        // still the exact thing that was reviewed above: re-inspect the
        // worktree from scratch (re-stage with `git add -A` so any
        // test-created untracked file is picked up, never silently
        // dropped or silently smuggled in unreviewed) and recompute the
        // diff. Only when it is byte-for-byte identical to the pre-gate
        // reviewed diff is it trusted outright; any difference at all
        // means the *entire* policy/secret/size/protected-path review
        // gate runs again against the exact post-gate diff, and only that
        // exact, freshly re-reviewed index is ever committed.
        const postGateAdd = await spawnFn(['git', 'add', '-A'], { cwd: worktreePath, env: restrictedEnv, timeoutMs: 15_000 });
        if (!postGateAdd.success) {
            return await failForRetry(work, issue, `git add failed after the gate: ${postGateAdd.stderr.slice(-1000)}`, now, repoRoot, branchName, spawnFn, restrictedEnv);
        }
        const postGateNumstat = await spawnFn(['git', 'diff', '--cached', '--no-renames', '--numstat'], { cwd: worktreePath, env: restrictedEnv, timeoutMs: 15_000 });
        const postGateDiff = await spawnFn(['git', 'diff', '--cached', '--no-renames'], { cwd: worktreePath, env: restrictedEnv, timeoutMs: 15_000 });
        if (!postGateNumstat.success || !postGateDiff.success) {
            return await failForRetry(
                work,
                issue,
                `could not independently inspect the staged change after the gate ('git diff' failed): ${postGateNumstat.stderr.slice(-500)} ${postGateDiff.stderr.slice(-500)}`.trim(),
                now,
                repoRoot,
                branchName,
                spawnFn,
                restrictedEnv
            );
        }
        let finalChangeSummary = changeSummary;
        let finalDiffText = diff.stdout;
        if (postGateDiff.stdout !== diff.stdout) {
            finalChangeSummary = parseNumstat(postGateNumstat.stdout);
            finalDiffText = postGateDiff.stdout;
            const postGateReview = await validateAndReviewChange(
                issue,
                work,
                finalChangeSummary,
                finalDiffText,
                changeLimits,
                patchReviewFn,
                patchReviewQuorumFn,
                repoRoot,
                'post-gate'
            );
            if (!postGateReview.ok) {
                return await failForRetry(
                    work,
                    issue,
                    `${postGateReview.reason ?? 'post-gate review rejected the change'} (the worktree changed during the sandboxed verification gate run)`,
                    now,
                    repoRoot,
                    branchName,
                    spawnFn,
                    restrictedEnv
                );
            }
            log('note', {
                msg: 'the worktree changed during the sandboxed gate run; re-validated and re-reviewed the exact post-gate diff before committing it',
                issueId: issue.id,
                workId: work.id,
            });
        }

        const commit = await spawnFn(['git', 'commit', '-m', buildAutonomousCommitMessage(issue, result)], {
            cwd: worktreePath,
            env: restrictedEnv,
            timeoutMs: 30_000,
        });
        if (!commit.success) {
            return await failForRetry(work, issue, `commit failed: ${commit.stderr.slice(-1000)}`, now, repoRoot, branchName, spawnFn, restrictedEnv);
        }
        const rev = await spawnFn(['git', 'rev-parse', 'HEAD'], { cwd: worktreePath, env: restrictedEnv, timeoutMs: 15_000 });
        const commitSha = rev.stdout.trim();

        const canary = transitionMaintenanceWork({
            id: work.id,
            status: 'canary',
            commitSha,
            patchManifest: finalDiffText.slice(-4000),
            canaryOutcome: JSON.stringify({ awaitingDeployment: true }),
        });
        transitionIssue({ id: issue.id, status: 'canary' });
        log('maintenance_work', {
            workId: canary.id,
            issueId: issue.id,
            recipeId: AUTONOMOUS_RECIPE_ID,
            status: 'canary',
            commitSha,
            branchName,
        });
        return canary;
    } finally {
        // The worktree is always removed; the branch survives only for
        // canary commits (handled by the caller keeping it, since we never
        // explicitly delete it on the success path above).
        await spawnFn(['git', 'worktree', 'remove', '--force', worktreePath], {
            cwd: repoRoot,
            env: restrictedEnv,
            timeoutMs: 15_000,
        }).catch(() => undefined);
    }
}
