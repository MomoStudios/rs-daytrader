import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { OperatorDecision, OperatorEscalation, OperatorWorkflow } from './operatorSchema';
import type { ProgressSnapshot } from './operatorWatchdog';

const __dirname = dirname(fileURLToPath(import.meta.url));
let dataDir = join(__dirname, '..', 'data');

function operatorPath(): string {
    return join(dataDir, 'operator.json');
}

function tempPath(): string {
    return `${operatorPath()}.tmp`;
}

export interface OperatorRemediationState {
    reason: string | null;
    attempts: number;
    diagnosisAttempts: number;
}

export interface OperatorRuntimeState {
    decision: OperatorDecision | null;
    workflow: OperatorWorkflow | null;
    stepIndex: number;
    stepAttempts: number;
    sameFailureCount: number;
    lastFailure: string | null;
    lastProgressAt: number;
    baseline: ProgressSnapshot | null;
    lastSnapshot: ProgressSnapshot | null;
    recentEvidence: string[];
    pendingEscalation: OperatorEscalation | null;
    /** Issue registry id owning the current pendingEscalation, if any. Set
     *  exclusively by escalationStore.ts so acknowledgement/timeout can find
     *  the exact issue row instead of re-deriving a fingerprint. */
    pendingEscalationIssueId: string | null;
    lastPlannedAt: number;
    lastDiagnosedAt: number;
    remediation: OperatorRemediationState;
}

function defaultRemediation(): OperatorRemediationState {
    return { reason: null, attempts: 0, diagnosisAttempts: 0 };
}

function defaults(): OperatorRuntimeState {
    return {
        decision: null,
        workflow: null,
        stepIndex: 0,
        stepAttempts: 0,
        sameFailureCount: 0,
        lastFailure: null,
        lastProgressAt: Date.now(),
        baseline: null,
        lastSnapshot: null,
        recentEvidence: [],
        pendingEscalation: null,
        pendingEscalationIssueId: null,
        lastPlannedAt: 0,
        lastDiagnosedAt: 0,
        remediation: defaultRemediation(),
    };
}

let state: OperatorRuntimeState | null = null;

/**
 * Test-only hook: drop the cached runtime state and optionally redirect
 * persistence to an isolated directory so escalation/remediation tests
 * never touch the real operator.json. Never called in production.
 */
export function _resetOperatorStateForTests(dir?: string): void {
    state = null;
    if (dir) dataDir = dir;
}

export function loadOperatorState(): OperatorRuntimeState {
    if (state) return state;
    if (!existsSync(operatorPath())) {
        state = defaults();
        return state;
    }
    try {
        state = { ...defaults(), ...(JSON.parse(readFileSync(operatorPath(), 'utf8')) as Partial<OperatorRuntimeState>) };
    } catch (error) {
        console.warn(`[operatorStore] Could not read operator state: ${error}`);
        state = defaults();
    }
    return state;
}

export function saveOperatorState(): void {
    if (!state) return;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(tempPath(), JSON.stringify(state, null, 2));
    renameSync(tempPath(), operatorPath());
}

/**
 * Installs a new workflow/decision. Deliberately does not touch
 * pendingEscalation itself (see resetOperatorWorkflow's note) - callers
 * that install a decision carrying an escalation must explicitly raise it
 * via escalationStore.raiseOperatorEscalation, and callers replacing a
 * previously-escalating decision must explicitly acknowledge the old one
 * first. This is what makes strategist replanning an explicit
 * acknowledge/resolve/replace instead of a silent overwrite.
 */
export function installOperatorDecision(decision: OperatorDecision, baseline: ProgressSnapshot): void {
    const current = loadOperatorState();
    current.decision = decision;
    current.workflow = decision.workflow;
    current.stepIndex = 0;
    current.stepAttempts = 0;
    current.sameFailureCount = 0;
    current.lastFailure = null;
    current.lastProgressAt = Date.now();
    current.baseline = baseline;
    current.lastSnapshot = baseline;
    current.recentEvidence = [];
    current.lastPlannedAt = Date.now();
    current.remediation = defaultRemediation();
    saveOperatorState();
}

export function clearOperatorEscalation(): void {
    const current = loadOperatorState();
    current.pendingEscalation = null;
    current.pendingEscalationIssueId = null;
    saveOperatorState();
}

/**
 * Resets *workflow execution progress* only. Deliberately does not touch
 * pendingEscalation: escalation ownership/lifecycle is explicit (see
 * escalationStore.ts's acknowledgeOperatorEscalation) and must never be
 * cleared as a side effect of an unrelated workflow reset, or a stale
 * escalation could be silently dropped without ever being resolved.
 */
export function resetOperatorWorkflow(): void {
    const current = loadOperatorState();
    current.workflow = null;
    current.stepIndex = 0;
    current.stepAttempts = 0;
    current.baseline = null;
    current.lastSnapshot = null;
    current.remediation = defaultRemediation();
    saveOperatorState();
}

export function setOperatorEscalation(escalation: OperatorEscalation, issueId: string | null = null): void {
    const current = loadOperatorState();
    current.pendingEscalation = escalation;
    current.pendingEscalationIssueId = issueId;
    saveOperatorState();
}

export function updateOperatorRemediation(next: OperatorRemediationState): void {
    const current = loadOperatorState();
    current.remediation = next;
    saveOperatorState();
}
