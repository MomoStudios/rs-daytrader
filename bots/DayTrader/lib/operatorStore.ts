import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { OperatorDecision, OperatorEscalation, OperatorWorkflow } from './operatorSchema';
import type { ProgressSnapshot } from './operatorWatchdog';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const OPERATOR_PATH = join(DATA_DIR, 'operator.json');
const TEMP_PATH = `${OPERATOR_PATH}.tmp`;

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
    lastPlannedAt: number;
    lastDiagnosedAt: number;
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
        lastPlannedAt: 0,
        lastDiagnosedAt: 0,
    };
}

let state: OperatorRuntimeState | null = null;

export function loadOperatorState(): OperatorRuntimeState {
    if (state) return state;
    if (!existsSync(OPERATOR_PATH)) {
        state = defaults();
        return state;
    }
    try {
        state = { ...defaults(), ...(JSON.parse(readFileSync(OPERATOR_PATH, 'utf8')) as Partial<OperatorRuntimeState>) };
    } catch (error) {
        console.warn(`[operatorStore] Could not read operator state: ${error}`);
        state = defaults();
    }
    return state;
}

export function saveOperatorState(): void {
    if (!state) return;
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TEMP_PATH, JSON.stringify(state, null, 2));
    renameSync(TEMP_PATH, OPERATOR_PATH);
}

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
    current.pendingEscalation = decision.escalation;
    current.lastPlannedAt = Date.now();
    saveOperatorState();
}

export function clearOperatorEscalation(): void {
    const current = loadOperatorState();
    current.pendingEscalation = null;
    saveOperatorState();
}

export function resetOperatorWorkflow(): void {
    const current = loadOperatorState();
    current.workflow = null;
    current.stepIndex = 0;
    current.stepAttempts = 0;
    current.baseline = null;
    current.lastSnapshot = null;
    saveOperatorState();
}
