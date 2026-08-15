export function enqueueUniqueName(queue: string[], name: string): boolean {
    const normalized = name.trim();
    if (!normalized) return false;
    if (queue.some(existing => existing.toLowerCase() === normalized.toLowerCase())) {
        return false;
    }
    queue.push(normalized);
    return true;
}

export function preparedPlanIsStale(input: {
    planChatGeneration: number;
    currentChatGeneration: number;
    planGuidanceIds: string[];
    pendingGuidanceIds: string[];
}): boolean {
    return (
        input.planChatGeneration < input.currentChatGeneration ||
        input.pendingGuidanceIds.some(id => !input.planGuidanceIds.includes(id))
    );
}
