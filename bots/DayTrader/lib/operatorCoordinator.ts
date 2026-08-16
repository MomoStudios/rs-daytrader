import type { SkillContext, SkillResult } from './skillLibrary';
import { DayTraderOperatorBrain, type OperatorPlanningRequest } from './operatorBrain';
import type { OperatorDecision } from './operatorSchema';
import { executeOperatorDirective } from './operatorExecutor';
import {
    installOperatorDecision,
    loadOperatorState,
    resetOperatorWorkflow,
    saveOperatorState,
    updateOperatorRemediation,
} from './operatorStore';
import { assessStall, evaluateProgress, snapshotProgress } from './operatorWatchdog';
import { log } from './logger';
import { workflowHash } from './workflowStore';
import { proposeWorkflowCandidate, recordWorkflowCandidateOutcome, type WorkflowCandidateSource } from './workflowCandidateStore';
import { reservationViolations } from './reservationPolicy';
import { computeFingerprint, recordIssue } from './issueRegistry';
import { applyRemediation, decideRemediation } from './operatorRemediation';
import { recordExecutionFeedback } from './executionFeedback';
import { acknowledgeOperatorEscalation, raiseOperatorEscalation } from './escalationStore';

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
        this.installDecision(decision, ctx, request, 'operator_plan');
    }

    /**
     * Shared install path for both a fresh strategist-driven plan and an
     * operator diagnosis repair. Reservation violations never throw here:
     * they become a typed issue plus a policy escalation for the
     * strategist, so a bad plan is safely deferred instead of crashing the
     * runtime loop. Reusable workflows never persist directly into the
     * production registry - every one becomes a candidate that must pass
     * static verification and prove itself in canary executions first.
     */
    private installDecision(
        decision: OperatorDecision,
        ctx: SkillContext,
        request: OperatorPlanningRequest | undefined,
        source: WorkflowCandidateSource
    ): void {
        let effectiveDecision = decision;
        let reservationIssueId: string | null = null;
        if (decision.workflow && request) {
            const violations = reservationViolations(
                decision.workflow,
                request.materialReservations,
                request.assetMemory
            );
            if (violations.length > 0) {
                const issue = recordIssue({
                    fingerprint: computeFingerprint(['reservation_violation', decision.workflow.name, ...violations]),
                    ownerLayer: 'operator',
                    severity: 'high',
                    category: 'reservation_violation',
                    title: `Workflow '${decision.workflow.name}' violates a material reservation`,
                    description: violations.join('; '),
                    evidence: violations,
                });
                reservationIssueId = issue.id;
                log('operator_issue', { issueId: issue.id, category: issue.category, violations });
                effectiveDecision = {
                    ...decision,
                    workflow: null,
                    escalation: {
                        reason: 'policy_violation',
                        question: `Workflow '${decision.workflow.name}' would consume a reserved material. Choose a different approach or release the reservation.`,
                        evidence: violations.slice(0, 10),
                        suggestedOptions: [
                            'Choose a workflow that does not consume the reserved material',
                            'Release or reduce the material reservation',
                            'Defer this workflow until the reservation is fulfilled',
                        ],
                    },
                };
            }
        }

        const hadPendingEscalation = !!loadOperatorState().pendingEscalation;
        const baseline = snapshotProgress(ctx.sdk.getState());
        installOperatorDecision(effectiveDecision, baseline);
        if (effectiveDecision.workflow) {
            proposeWorkflowCandidate({
                workflow: effectiveDecision.workflow,
                source,
                materialReservations: request?.materialReservations,
                assetMemory: request?.assetMemory,
            });
        }
        log('operator_plan', {
            model: this.brain.getModel(),
            mode: source === 'operator_plan' ? 'plan' : 'diagnosis',
            summary: effectiveDecision.summary,
            blockers: effectiveDecision.blockers,
            workflow: effectiveDecision.workflow,
            escalation: effectiveDecision.escalation,
        });

        // Explicit acknowledge/resolve/replace: a new decision always
        // either resolves any previously pending escalation (by replacing
        // it with productive work or a fresh escalation) or, if it raises
        // its own escalation, that becomes the new tracked issue. Never a
        // silent overwrite.
        if (hadPendingEscalation) {
            acknowledgeOperatorEscalation(
                `replaced by a new ${source === 'operator_plan' ? 'plan' : 'diagnosis repair'}: ${effectiveDecision.summary}`
            );
        }
        if (effectiveDecision.escalation) {
            raiseOperatorEscalation(effectiveDecision.escalation, reservationIssueId);
        }
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
                recordWorkflowCandidateOutcome(workflowHash(workflow), 'success', 'workflow completed all steps');
                recordExecutionFeedback({
                    workflowId: workflow.name,
                    stepId: step.id,
                    directiveType: step.directive.type,
                    outcome: 'workflow_completed',
                    evidence: evaluation.evidence,
                });
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
        const effectiveStall =
            exhausted && !stall.stalled
                ? {
                      stalled: true as const,
                      reason: 'repeated_failure' as const,
                      evidence: [`step exceeded maxAttempts=${step.maxAttempts}`],
                  }
                : stall;

        if (!effectiveStall.stalled) return actionResult;

        // Deterministic remediation runs before any model diagnosis or
        // strategist escalation, and bounds how many times we retry the
        // same failure mode before giving up on it.
        const remediation = decideRemediation(effectiveStall, runtime.remediation);
        updateOperatorRemediation(remediation.nextRemediation);
        log('operator_remediation', {
            workflow: workflow.name,
            step: step.id,
            stall: effectiveStall,
            action: remediation.action,
            note: remediation.note,
        });
        recordExecutionFeedback({
            workflowId: workflow.name,
            stepId: step.id,
            directiveType: step.directive.type,
            outcome: `stall:${effectiveStall.reason}:${remediation.action}`,
            evidence: effectiveStall.evidence,
        });

        if (remediation.action === 'dismiss_ui' || remediation.action === 'wait_reconnect' || remediation.action === 'wait_replan') {
            const note = await applyRemediation(remediation.action, ctx);
            log('operator_remediation_applied', { action: remediation.action, note });
            return actionResult;
        }

        if (!this.available || !this.request) return actionResult;

        if (remediation.action === 'escalate') {
            recordWorkflowCandidateOutcome(workflowHash(workflow), 'failure', remediation.note);
            const issue = recordIssue({
                fingerprint: computeFingerprint(['operator_repeated_failure', workflow.name, step.id]),
                ownerLayer: 'strategist',
                severity: 'high',
                category: 'failure',
                title: `Workflow '${workflow.name}' step '${step.id}' repeatedly failed`,
                description: remediation.note,
                evidence: effectiveStall.evidence,
            });
            resetOperatorWorkflow();
            const escalation = {
                reason: 'repeated_failure' as const,
                question: 'Deterministic recovery and bounded diagnosis both exhausted their budget; should the strategist replace this goal or execution approach?',
                evidence: [remediation.note, ...effectiveStall.evidence],
                suggestedOptions: [
                    'Choose another productive progression goal',
                    'Retry later with a simpler workflow',
                ],
            };
            raiseOperatorEscalation(escalation, issue.id);
            return actionResult;
        }

        // remediation.action === 'diagnose'
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
            recordWorkflowCandidateOutcome(workflowHash(workflow), 'failure', remediation.note);
            this.installDecision(diagnosis, ctx, this.request, 'operator_diagnosis');
        } catch (error) {
            recordWorkflowCandidateOutcome(workflowHash(workflow), 'failure', `diagnosis threw: ${error}`);
            resetOperatorWorkflow();
            const issue = recordIssue({
                fingerprint: computeFingerprint(['operator_diagnosis_failed', workflow.name, step.id]),
                ownerLayer: 'strategist',
                severity: 'high',
                category: 'failure',
                title: `Operator diagnosis failed validation for workflow '${workflow.name}'`,
                description: String(error),
                evidence: [String(error), ...effectiveStall.evidence],
            });
            const escalation = {
                reason: 'repeated_failure' as const,
                question: 'Operator diagnosis failed validation; should the strategist replace this execution approach?',
                evidence: [String(error), ...effectiveStall.evidence],
                suggestedOptions: [
                    'Choose another productive progression goal',
                    'Retry with a simpler workflow',
                ],
            };
            raiseOperatorEscalation(escalation, issue.id);
        }
        return actionResult;
    }

    async stop(): Promise<void> {
        this.available = false;
        await this.brain.stop();
    }
}
