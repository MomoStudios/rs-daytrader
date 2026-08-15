import type { SkillState } from '../../../sdk/types';
import type { StrategicGoal } from './aiDecision';
import type { AssetMemory } from './assetMemory';

export interface GoalCompletion {
    complete: boolean;
    evidence: string;
    matchedTarget: string | null;
    actualValue: number;
}

function canonical(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map(word => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
        .join(' ');
}

export function evaluateGoalCompletion(
    goal: StrategicGoal,
    assets: AssetMemory,
    skills: SkillState[]
): GoalCompletion {
    const target = canonical(goal.target);
    if (goal.kind === 'leveling') {
        const skill = skills.find(candidate => target.includes(canonical(candidate.name)));
        const value = skill?.baseLevel ?? 0;
        return {
            complete: value >= goal.targetValue,
            evidence: skill
                ? `${skill.name} is level ${value}; target is ${goal.targetValue}`
                : `No skill name matched "${goal.target}"`,
            matchedTarget: skill?.name ?? null,
            actualValue: value,
        };
    }

    if (goal.kind === 'wealth') {
        const coins =
            assets.combinedHoldings.find(item => canonical(item.name) === 'coin')?.count ?? 0;
        return {
            complete: coins >= goal.targetValue,
            evidence: `Account holdings contain ${coins} coins; target is ${goal.targetValue}`,
            matchedTarget: 'Coins',
            actualValue: coins,
        };
    }

    const candidates = assets.combinedHoldings
        .filter(item => target.includes(canonical(item.name)))
        .sort((a, b) => canonical(b.name).length - canonical(a.name).length);
    const item = candidates[0];
    const value = item?.count ?? 0;
    return {
        complete: value >= goal.targetValue,
        evidence: item
            ? `Account holdings contain ${value} ${item.name}; target is ${goal.targetValue}`
            : `No held item matched "${goal.target}"`,
        matchedTarget: item?.name ?? null,
        actualValue: value,
    };
}

const GUIDANCE_STOP_WORDS = new Set([
    'acquire',
    'collect',
    'make',
    'smelt',
    'smith',
    'train',
    'level',
    'continue',
    'until',
    'have',
    'with',
]);

export function guidanceIdsSatisfiedByGoal(
    guidance: Array<{ id: string; text: string }>,
    goal: StrategicGoal
): string[] {
    const goalWords = new Set(
        canonical(goal.target)
            .split(' ')
            .filter(word => word.length >= 4 && !GUIDANCE_STOP_WORDS.has(word))
    );
    return guidance
        .filter(instruction =>
            canonical(instruction.text)
                .split(' ')
                .some(word => goalWords.has(word))
        )
        .map(instruction => instruction.id);
}
