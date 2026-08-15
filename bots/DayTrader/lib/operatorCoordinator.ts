import type { SkillContext, SkillResult } from './skillLibrary';
import { DayTraderOperatorBrain, type OperatorPlanningRequest } from './operatorBrain';
import type { OperatorDecision } from './operatorSchema';
import { executeOperatorDirective } from './operatorExecutor';
import {
    installOperatorDecision,
    loadOperatorState,
    resetOperatorWorkflow,
    saveOperatorState,
    setOperatorEscalation,
} from './operatorStore';
import { assessStall, evaluateProgress, snapshotProgress } from './operatorWatchdog';
import { log } from './logger';
import { storeReusableWorkflow } from './workflowStore';
import { reservationViolations } from './reservationPolicy';

export class OperatorCoordinator {
    private brain = new DayTraderOperatorBrain();
    private available = false;
    private request: OperatorPlanningRequest | null = null;

    async start(): Promise<void> {
        await this.brain.start();
        this.available = true;
        log('note', { msg: 'operator AI started', model: this.brain.getModel(), toolsEnabled: false });
    }

    isAvailable(): boolean {
        return this.available;
    }

    getModel(): string {
        return this.brain.getModel();
    }

    needsAudit(now = Date.now(), intervalMs = 5 * 60 * 1000): boolean {
        const state = loadOperatorState();
        return !!state.workflow && now - state.lastPlannedAt >= intervalMs;
    }

    setPlanningContext(request: OperatorPlanningRequest): void {
        this.request = request;
    }

    async plan(request: OperatorPlanningRequest, ctx: SkillContext): Promise<void> {
        const decision = await this.preparePlan(request);
        this.installPreparedPlan(decision, ctx, request);
    }

    async preparePlan(request: OperatorPlanningRequest): Promise<OperatorDecision> {
        if (!this.available) throw new Error('Operator AI is unavailable');
        return this.brain.plan(request);
    }

    installPreparedPlan(
        decision: OperatorDecision,
        ctx: SkillContext,
        request?: OperatorPlanningRequest
    ): void {
        if (request) this.request = request;
        if (decision.workflow && request) {
            const violations = reservationViolations(
                decision.workflow,
                request.materialReservations,
                request.assetMemory
            );
            if (violations.length > 0) {
                throw new Error(`Workflow violates material reservations: ${violations.join('; ')}`);
            }
        }
        const baseline = snapshotProgress(ctx.sdk.getState());
        installOperatorDecision(decision, baseline);
        if (decision.workflow) storeReusableWorkflow(decision.workflow);
        log('operator_plan', {
            model: this.brain.getModel(),
            summary: decision.summary,
            blockers: decision.blockers,
            workflow: decision.workflow,
            escalation: decision.escalation,
        });
        if (decision.escalation) log('operator_escalation', { ...decision.escalation });
    }

    async executeOne(ctx: SkillContext): Promise<SkillResult | null> {
        const runtime = loadOperatorState();
        const workflow = runtime.workflow;
        if (!workflow || runtime.stepIndex >= workflow.steps.length) return null;

        const step = workflow.steps[runtime.stepIndex];
        if (!step) {
            resetOperatorWorkflow();
            return null;
        }

        const before = runtime.baseline ?? snapshotProgress(ctx.sdk.getState());
        const previousAttempt = runtime.lastSnapshot ?? before;
        const stateAgeMs = ctx.sdk.getStateAge();
        const actionResult =
            stateAgeMs > 30_000
                ? {
                      success: false,
                      action: 'operator:state_guard',
                      message: `Refusing action on stale state (${stateAgeMs}ms old)`,
                  }
                : await executeOperatorDirective(ctx, step.directive);
        const after = snapshotProgress(ctx.sdk.getState());
        const completionEvaluation = evaluateProgress(before, after, step.completion, actionResult.success);
        const attemptEvaluation = evaluateProgress(
            previousAttempt,
            after,
            step.completion,
            actionResult.success
        );
        const evaluation = {
            complete: completionEvaluation.complete,
            progressed: completionEvaluation.complete || attemptEvaluation.progressed,
            evidence: attemptEvaluation.evidence,
        };

        runtime.stepAttempts += 1;
        runtime.recentEvidence = evaluation.evidence.slice(-20);
        if (evaluation.progressed) runtime.lastProgressAt = Date.now();

        if (!actionResult.success) {
            runtime.sameFailureCount =
                runtime.lastFailure === actionResult.message ? runtime.sameFailureCount + 1 : 1;
            runtime.lastFailure = actionResult.message;
        } else {
            runtime.sameFailureCount = 0;
            runtime.lastFailure = null;
        }

        if (evaluation.complete) {
            runtime.stepIndex += 1;
            runtime.stepAttempts = 0;
            runtime.baseline = after;
            runtime.lastSnapshot = after;
            runtime.recentEvidence = [];
            if (runtime.stepIndex >= workflow.steps.length) {
                log('note', { msg: 'operator workflow completed', workflow: workflow.name });
                resetOperatorWorkflow();
                return actionResult;
            }
            saveOperatorState();
            return actionResult;
        }

        runtime.baseline = step.repeatUntilComplete ? before : after;
        runtime.lastSnapshot = after;
        saveOperatorState();

        const stall = assessStall({
            attempts: runtime.stepAttempts,
            lastProgressAt: runtime.lastProgressAt,
            now: Date.now(),
            stateAgeMs,
            sameFailureCount: runtime.sameFailureCount,
            snapshot: after,
            recentEvidence: evaluation.evidence,
        });
        const exhausted = runtime.stepAttempts >= step.maxAttempts;
        if ((stall.stalled || exhausted) && this.available && this.request) {
            const effectiveStall = exhausted && !stall.stalled
                ? {
                      stalled: true as const,
                      reason: 'repeated_failure' as const,
                      evidence: [`step exceeded maxAttempts=${step.maxAttempts}`],
                  }
                : stall;
            log('operator_stall', {
                workflow: workflow.name,
                step: step.id,
                attempts: runtime.stepAttempts,
                stall: effectiveStall,
                actionResult,
            });
            runtime.lastDiagnosedAt = Date.now();
            saveOperatorState();
            try {
                const diagnosis = await this.brain.diagnose({
                    ...this.request,
                    activeWorkflow: workflow,
                    runtime,
                    before,
                    after,
                    stall: effectiveStall,
                });
                installOperatorDecision(diagnosis, after);
                if (diagnosis.workflow) storeReusableWorkflow(diagnosis.workflow);
                log('operator_plan', {
                    model: this.brain.getModel(),
                    mode: 'diagnosis',
                    summary: diagnosis.summary,
                    blockers: diagnosis.blockers,
                    workflow: diagnosis.workflow,
                    escalation: diagnosis.escalation,
                });
                if (diagnosis.escalation) log('operator_escalation', { ...diagnosis.escalation });
            } catch (error) {
                resetOperatorWorkflow();
                const escalation = {
                    reason: 'repeated_failure' as const,
                    question: 'Operator diagnosis failed validation; should the strategist replace this execution approach?',
                    evidence: [String(error), ...effectiveStall.evidence],
                    suggestedOptions: [
                        'Choose another productive progression goal',
                        'Retry with a simpler workflow',
                    ],
                };
                setOperatorEscalation(escalation);
                log('operator_escalation', { ...escalation });
            }
        }
        return actionResult;
    }

    async stop(): Promise<void> {
        this.available = false;
        await this.brain.stop();
    }
}
