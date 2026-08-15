export const DEFAULT_AI_MODEL = 'gpt-5.6-luna';
export const DEFAULT_AI_REASONING_EFFORT = 'medium' as const;

export function strategistModel(): string {
    return process.env.DAYTRADER_AI_MODEL?.trim() || DEFAULT_AI_MODEL;
}

export function operatorModel(): string {
    return process.env.DAYTRADER_OPERATOR_MODEL?.trim() || DEFAULT_AI_MODEL;
}
