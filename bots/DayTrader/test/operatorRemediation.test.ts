import { describe, expect, test } from 'bun:test';
import { DEFAULT_REMEDIATION_BUDGETS, decideRemediation, type RemediationBudgets } from '../lib/operatorRemediation';
import type { OperatorRemediationState } from '../lib/operatorStore';
import type { StallAssessment } from '../lib/operatorWatchdog';

function remediation(overrides: Partial<OperatorRemediationState> = {}): OperatorRemediationState {
    return { reason: null, attempts: 0, diagnosisAttempts: 0, ...overrides };
}

function stall(reason: StallAssessment['reason'], evidence: string[] = ['evidence']): StallAssessment {
    return { stalled: reason !== 'none', reason, evidence };
}

describe('operator remediation - routing', () => {
    test('a non-stalled assessment requires no remediation and resets counters', () => {
        const decision = decideRemediation(stall('none'), remediation({ reason: 'blocked_ui', attempts: 2 }));
        expect(decision.action).toBe('none');
        expect(decision.nextRemediation).toEqual({ reason: null, attempts: 0, diagnosisAttempts: 0 });
    });

    test('blocked_ui routes to bounded dismiss attempts before falling to diagnosis', () => {
        let state = remediation();
        for (let i = 1; i <= DEFAULT_REMEDIATION_BUDGETS.blockedUi; i++) {
            const decision = decideRemediation(stall('blocked_ui'), state);
            expect(decision.action).toBe('dismiss_ui');
            expect(decision.nextRemediation.attempts).toBe(i);
            state = decision.nextRemediation;
        }
        const exhausted = decideRemediation(stall('blocked_ui'), state);
        expect(exhausted.action).toBe('diagnose');
    });

    test('state_stale routes to bounded reconnect waits before diagnosis', () => {
        let state = remediation();
        for (let i = 1; i <= DEFAULT_REMEDIATION_BUDGETS.stateStale; i++) {
            const decision = decideRemediation(stall('state_stale'), state);
            expect(decision.action).toBe('wait_reconnect');
            state = decision.nextRemediation;
        }
        expect(decideRemediation(stall('state_stale'), state).action).toBe('diagnose');
    });

    test('possible_competition and no_progress route to bounded wait+replan', () => {
        let state = remediation();
        for (let i = 1; i <= DEFAULT_REMEDIATION_BUDGETS.possibleCompetition; i++) {
            const decision = decideRemediation(stall('possible_competition'), state);
            expect(decision.action).toBe('wait_replan');
            state = decision.nextRemediation;
        }
        expect(decideRemediation(stall('possible_competition'), state).action).toBe('diagnose');

        let noProgressState = remediation();
        for (let i = 1; i <= DEFAULT_REMEDIATION_BUDGETS.noProgress; i++) {
            const decision = decideRemediation(stall('no_progress'), noProgressState);
            expect(decision.action).toBe('wait_replan');
            noProgressState = decision.nextRemediation;
        }
        expect(decideRemediation(stall('no_progress'), noProgressState).action).toBe('diagnose');
    });

    test('repeated_failure goes straight to bounded diagnosis, then escalates once exhausted', () => {
        let state = remediation();
        for (let i = 1; i <= DEFAULT_REMEDIATION_BUDGETS.repeatedFailureDiagnoses; i++) {
            const decision = decideRemediation(stall('repeated_failure'), state);
            expect(decision.action).toBe('diagnose');
            expect(decision.nextRemediation.diagnosisAttempts).toBe(i);
            state = decision.nextRemediation;
        }
        const escalated = decideRemediation(stall('repeated_failure'), state);
        expect(escalated.action).toBe('escalate');
    });

    test('a different stall reason resets the attempt counter instead of accumulating across reasons', () => {
        const afterBlockedUi = decideRemediation(stall('blocked_ui'), remediation({ reason: 'blocked_ui', attempts: 3 }));
        expect(afterBlockedUi.action).toBe('diagnose'); // budget already exhausted for blocked_ui

        const afterSwitch = decideRemediation(stall('no_progress'), remediation({ reason: 'blocked_ui', attempts: 3 }));
        expect(afterSwitch.action).toBe('wait_replan');
        expect(afterSwitch.nextRemediation.attempts).toBe(1);
    });

    test('transient faults never escalate directly - they always route through diagnose first', () => {
        const budgets: RemediationBudgets = { ...DEFAULT_REMEDIATION_BUDGETS, stateStale: 1 };
        const first = decideRemediation(stall('state_stale'), remediation(), budgets);
        expect(first.action).toBe('wait_reconnect');
        const second = decideRemediation(stall('state_stale'), first.nextRemediation, budgets);
        // budget exhausted -> hands off to model diagnosis, never straight to strategist escalation
        expect(second.action).toBe('diagnose');
    });

    test('custom budgets are respected', () => {
        const budgets: RemediationBudgets = { ...DEFAULT_REMEDIATION_BUDGETS, blockedUi: 1 };
        const first = decideRemediation(stall('blocked_ui'), remediation(), budgets);
        expect(first.action).toBe('dismiss_ui');
        const second = decideRemediation(stall('blocked_ui'), first.nextRemediation, budgets);
        expect(second.action).toBe('diagnose');
    });
});
