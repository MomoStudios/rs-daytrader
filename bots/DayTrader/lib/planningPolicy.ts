export interface PlanningPolicyInput {
    pendingChatForAi: boolean;
    hasActiveAction: boolean;
    now: number;
    lastPlannedAt: number;
    planIntervalMs: number;
}

export function shouldRequestAiPlan(input: PlanningPolicyInput): boolean {
    return (
        input.pendingChatForAi ||
        !input.hasActiveAction ||
        input.now - input.lastPlannedAt >= input.planIntervalMs
    );
}
