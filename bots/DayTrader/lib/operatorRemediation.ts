// DayTrader - Deterministic Operator Remediation
//
// Before any model diagnosis or strategist escalation, the operator tries
// bounded, deterministic recovery appropriate to *why* execution stalled.
// This keeps transient faults (a blocking dialog, a stale state snapshot,
// brief contention with another player) from ever reaching the model or the
// strategist unless the deterministic recovery budget is actually
// exhausted - and every attempt is recorded so the budget is enforceable
// across ticks.
//
// Routing summary:
// - blocked_ui           -> bounded dismiss/close attempts.
// - state_stale          -> bounded wait; the SDK's own autoReconnect does
//                           the actual reconnecting in the background, we
//                           only give it bounded time. getState() never
//                           "refreshes" by itself - waiting ticks is what
//                           lets a fresher state snapshot arrive.
// - possible_competition,
//   no_progress          -> bounded wait + replan (let the strategist/
//                           operator re-evaluate instead of hammering the
//                           same failing step).
// - repeated_failure     -> bounded number of model diagnosis calls, then
//                           escalate (typed issue) instead of diagnosing
//                           forever.
// - none                 -> no remediation necessary.

import type { SkillContext } from './skillLibrary';
import type { StallAssessment } from './operatorWatchdog';
import type { OperatorRemediationState } from './operatorStore';
import { executeOperatorDirective } from './operatorExecutor';

export type RemediationAction =
    | 'none'
    | 'dismiss_ui'
    | 'wait_reconnect'
    | 'wait_replan'
    | 'diagnose'
    | 'escalate';

export interface RemediationDecision {
    action: RemediationAction;
    nextRemediation: OperatorRemediationState;
    note: string;
}

export interface RemediationBudgets {
    blockedUi: number;
    stateStale: number;
    noProgress: number;
    possibleCompetition: number;
    repeatedFailureDiagnoses: number;
}

export const DEFAULT_REMEDIATION_BUDGETS: RemediationBudgets = {
    blockedUi: 3,
    stateStale: 5,
    noProgress: 2,
    possibleCompetition: 2,
    repeatedFailureDiagnoses: 3,
};

/**
 * Pure routing/recovery decision: given the current stall assessment and
 * the bounded attempt counters carried on operator runtime state, decide
 * the next deterministic action (or hand off to model diagnosis, or give
 * up and escalate). Contains no I/O so it is exhaustively unit-testable.
 */
export function decideRemediation(
    stall: StallAssessment,
    remediation: OperatorRemediationState,
    budgets: RemediationBudgets = DEFAULT_REMEDIATION_BUDGETS
): RemediationDecision {
    if (!stall.stalled || stall.reason === 'none') {
        return { action: 'none', nextRemediation: { reason: null, attempts: 0, diagnosisAttempts: 0 }, note: 'no stall' };
    }

    const sameReason = remediation.reason === stall.reason;
    const attempts = sameReason ? remediation.attempts + 1 : 1;
    const diagnosisAttempts = sameReason ? remediation.diagnosisAttempts : 0;

    switch (stall.reason) {
        case 'blocked_ui': {
            if (attempts <= budgets.blockedUi) {
                return {
                    action: 'dismiss_ui',
                    nextRemediation: { reason: stall.reason, attempts, diagnosisAttempts },
                    note: `deterministic dismiss attempt ${attempts}/${budgets.blockedUi}`,
                };
            }
            return {
                action: 'diagnose',
                nextRemediation: { reason: stall.reason, attempts, diagnosisAttempts },
                note: `blocked UI persisted past ${budgets.blockedUi} deterministic dismiss attempts`,
            };
        }
        case 'state_stale': {
            if (attempts <= budgets.stateStale) {
                return {
                    action: 'wait_reconnect',
                    nextRemediation: { reason: stall.reason, attempts, diagnosisAttempts },
                    note: `deterministic reconnect-wait ${attempts}/${budgets.stateStale}`,
                };
            }
            return {
                action: 'diagnose',
                nextRemediation: { reason: stall.reason, attempts, diagnosisAttempts },
                note: `state stayed stale past ${budgets.stateStale} bounded waits`,
            };
        }
        case 'possible_competition':
        case 'no_progress': {
            const budget = stall.reason === 'possible_competition' ? budgets.possibleCompetition : budgets.noProgress;
            if (attempts <= budget) {
                return {
                    action: 'wait_replan',
                    nextRemediation: { reason: stall.reason, attempts, diagnosisAttempts },
                    note: `deterministic wait+replan ${attempts}/${budget} for ${stall.reason}`,
                };
            }
            return {
                action: 'diagnose',
                nextRemediation: { reason: stall.reason, attempts, diagnosisAttempts },
                note: `${stall.reason} persisted past ${budget} bounded waits`,
            };
        }
        case 'repeated_failure': {
            const nextDiagnosisAttempts = diagnosisAttempts + 1;
            if (nextDiagnosisAttempts <= budgets.repeatedFailureDiagnoses) {
                return {
                    action: 'diagnose',
                    nextRemediation: { reason: stall.reason, attempts, diagnosisAttempts: nextDiagnosisAttempts },
                    note: `bounded diagnosis attempt ${nextDiagnosisAttempts}/${budgets.repeatedFailureDiagnoses}`,
                };
            }
            return {
                action: 'escalate',
                nextRemediation: { reason: stall.reason, attempts, diagnosisAttempts: nextDiagnosisAttempts },
                note: `repeated failure exceeded ${budgets.repeatedFailureDiagnoses} diagnosis attempts`,
            };
        }
        default:
            return {
                action: 'diagnose',
                nextRemediation: { reason: stall.reason, attempts, diagnosisAttempts },
                note: `unrecognized stall reason '${stall.reason}'`,
            };
    }
}

/** Applies a deterministic remediation action's bounded side effect. */
export async function applyRemediation(action: RemediationAction, ctx: SkillContext): Promise<string> {
    switch (action) {
        case 'dismiss_ui': {
            const result = await executeOperatorDirective(ctx, { type: 'dismiss_blocking_ui' });
            return `dismiss_blocking_ui: ${result.success}`;
        }
        case 'wait_reconnect': {
            // getState() returns the last received snapshot - it never
            // "refreshes" on its own. Waiting bounded ticks gives the SDK's
            // background autoReconnect logic (see BotSDK.autoReconnect) a
            // chance to land a fresh snapshot before we re-check staleness.
            await ctx.sdk.waitForTicks(2).catch(() => undefined);
            const connectionState = ctx.sdk.getConnectionState();
            const stateAgeMs = ctx.sdk.getStateAge();
            return `waited for reconnect: connectionState=${connectionState} stateAgeMs=${stateAgeMs}`;
        }
        case 'wait_replan': {
            await ctx.sdk.waitForTicks(2).catch(() => undefined);
            return 'waited before allowing a replan';
        }
        case 'none':
        case 'diagnose':
        case 'escalate':
        default:
            return `no deterministic side effect for action '${action}'`;
    }
}
