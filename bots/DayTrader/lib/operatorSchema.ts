import type { StrategicAction, StrategicGoal } from './aiDecision';

export type OperatorBlockerKind =
    | 'quest'
    | 'skill'
    | 'access'
    | 'resource'
    | 'competition'
    | 'navigation'
    | 'interface'
    | 'unknown';

export interface OperatorBlocker {
    kind: OperatorBlockerKind;
    target: string;
    evidence: string;
    severity: 'low' | 'medium' | 'high';
}

export interface OperatorEscalation {
    reason: 'competition' | 'goal_impractical' | 'missing_capability' | 'unsafe' | 'repeated_failure';
    question: string;
    evidence: string[];
    suggestedOptions: string[];
}

export type OperatorDirective =
    | { type: 'strategic_action'; action: StrategicAction }
    | { type: 'walk_to'; x: number; z: number; tolerance: number }
    | { type: 'open_door'; target: string }
    | { type: 'interact_npc'; target: string; option: string }
    | { type: 'interact_loc'; target: string; option: string }
    | { type: 'talk_to'; target: string }
    | { type: 'dialog_continue' }
    | { type: 'dialog_select'; option: string }
    | { type: 'dismiss_blocking_ui' }
    | { type: 'pickup'; item: string }
    | { type: 'use_item_on_loc'; item: string; location: string }
    | { type: 'bank_open' }
    | { type: 'bank_close' }
    | { type: 'bank_deposit'; item: string; amount: number }
    | { type: 'bank_withdraw'; item: string; amount: number }
    | { type: 'shop_open'; npc: string }
    | { type: 'shop_close' }
    | { type: 'shop_buy'; item: string; amount: number }
    | { type: 'equip_item'; item: string }
    | { type: 'set_combat_style'; skill: 'Attack' | 'Strength' | 'Defence' }
    | { type: 'attack_npc'; target: string }
    | { type: 'wait'; ticks: number };

export type CompletionCondition =
    | { type: 'action_success' }
    | { type: 'position'; x: number; z: number; tolerance: number }
    | { type: 'inventory'; item: string; count: number }
    | { type: 'skill_level'; skill: string; level: number }
    | { type: 'skill_xp_delta'; skill: string; delta: number }
    | { type: 'dialog_open' }
    | { type: 'dialog_closed' }
    | { type: 'interface_open' }
    | { type: 'interface_closed' };

export interface OperatorWorkflowStep {
    id: string;
    description: string;
    directive: OperatorDirective;
    completion: CompletionCondition;
    repeatUntilComplete: boolean;
    maxAttempts: number;
}

export interface OperatorWorkflow {
    name: string;
    goal: string;
    reusable: boolean;
    version: number;
    successCriteria: string[];
    steps: OperatorWorkflowStep[];
}

export interface OperatorDecision {
    summary: string;
    goal: StrategicGoal;
    blockers: OperatorBlocker[];
    workflow: OperatorWorkflow | null;
    escalation: OperatorEscalation | null;
}

const BLOCKER_KINDS = new Set([
    'quest',
    'skill',
    'access',
    'resource',
    'competition',
    'navigation',
    'interface',
    'unknown',
]);
const SEVERITIES = new Set(['low', 'medium', 'high']);
const ESCALATION_REASONS = new Set([
    'competition',
    'goal_impractical',
    'missing_capability',
    'unsafe',
    'repeated_failure',
]);
const DIRECTIVE_TYPES = new Set([
    'strategic_action',
    'walk_to',
    'open_door',
    'interact_npc',
    'interact_loc',
    'talk_to',
    'dialog_continue',
    'dialog_select',
    'dismiss_blocking_ui',
    'pickup',
    'use_item_on_loc',
    'bank_open',
    'bank_close',
    'bank_deposit',
    'bank_withdraw',
    'shop_open',
    'shop_close',
    'shop_buy',
    'equip_item',
    'set_combat_style',
    'attack_npc',
    'wait',
]);
const COMPLETION_TYPES = new Set([
    'action_success',
    'position',
    'inventory',
    'skill_level',
    'skill_xp_delta',
    'dialog_open',
    'dialog_closed',
    'interface_open',
    'interface_closed',
]);

function record(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${field} must be an object`);
    }
    return value as Record<string, unknown>;
}

function string(value: unknown, field: string, max = 240): string {
    if (typeof value !== 'string') throw new Error(`${field} must be a string`);
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > max) throw new Error(`${field} must be 1-${max} characters`);
    return normalized;
}

function integer(value: unknown, field: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${field} must be an integer between ${min} and ${max}`);
    }
    return value;
}

function stringArray(value: unknown, field: string, maxItems: number): string[] {
    if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} must contain at most ${maxItems} items`);
    return value.map((entry, index) => string(entry, `${field}[${index}]`, 240));
}

function goal(value: unknown): StrategicGoal {
    const data = record(value, 'goal');
    if (!['leveling', 'item_acquisition', 'wealth'].includes(String(data.kind))) {
        throw new Error('goal.kind is invalid');
    }
    return {
        kind: data.kind as StrategicGoal['kind'],
        target: string(data.target, 'goal.target', 160),
        targetValue: integer(data.targetValue, 'goal.targetValue', 1, 10_000_000),
        rationale: string(data.rationale, 'goal.rationale', 240),
    };
}

function strategicAction(value: unknown): StrategicAction {
    const data = record(value, 'directive.action');
    switch (data.type) {
        case 'train':
            if (!['woodcutting', 'fishing', 'mining', 'firemaking', 'cooking', 'smithing'].includes(String(data.activity))) {
                throw new Error('directive.action.activity is invalid');
            }
            return { type: 'train', activity: data.activity as Extract<StrategicAction, { type: 'train' }>['activity'] };
        case 'travel':
            if (
                ![
                    'lumbridge_market',
                    'lumbridge_trees',
                    'lumbridge_range',
                    'lumbridge_furnace',
                    'draynor_fishing',
                    'varrock_oaks',
                    'draynor_willows',
                    'se_varrock_mine',
                    'varrock_anvil',
                ].includes(String(data.destination))
            ) {
                throw new Error('directive.action.destination is invalid');
            }
            return {
                type: 'travel',
                destination: data.destination as Extract<StrategicAction, { type: 'travel' }>['destination'],
            };
        case 'sell_excess':
        case 'pickup':
        case 'wait':
            return { type: data.type };
        default:
            throw new Error('directive.action.type is invalid');
    }
}

function directive(value: unknown): OperatorDirective {
    const data = record(value, 'directive');
    if (typeof data.type !== 'string' || !DIRECTIVE_TYPES.has(data.type)) throw new Error('directive.type is invalid');
    switch (data.type) {
        case 'strategic_action':
            return { type: 'strategic_action', action: strategicAction(data.action) };
        case 'walk_to':
            return {
                type: 'walk_to',
                x: integer(data.x, 'directive.x', 0, 16_383),
                z: integer(data.z, 'directive.z', 0, 16_383),
                tolerance: integer(data.tolerance, 'directive.tolerance', 0, 10),
            };
        case 'open_door':
        case 'talk_to':
        case 'attack_npc':
            return { type: data.type, target: string(data.target, 'directive.target', 80) };
        case 'interact_npc':
        case 'interact_loc':
            return {
                type: data.type,
                target: string(data.target, 'directive.target', 80),
                option: string(data.option, 'directive.option', 80),
            };
        case 'dialog_continue':
        case 'dismiss_blocking_ui':
        case 'bank_open':
        case 'bank_close':
        case 'shop_close':
            return { type: data.type };
        case 'dialog_select':
            return { type: 'dialog_select', option: string(data.option, 'directive.option', 120) };
        case 'pickup':
            return { type: 'pickup', item: string(data.item, 'directive.item', 80) };
        case 'use_item_on_loc':
            return {
                type: 'use_item_on_loc',
                item: string(data.item, 'directive.item', 80),
                location: string(data.location, 'directive.location', 80),
            };
        case 'bank_deposit':
        case 'bank_withdraw':
        case 'shop_buy':
            return {
                type: data.type,
                item: string(data.item, 'directive.item', 80),
                amount: integer(data.amount, 'directive.amount', data.type === 'bank_deposit' ? -1 : 1, 10_000),
            };
        case 'shop_open':
            return { type: 'shop_open', npc: string(data.npc, 'directive.npc', 80) };
        case 'equip_item':
            return { type: 'equip_item', item: string(data.item, 'directive.item', 80) };
        case 'set_combat_style':
            if (!['Attack', 'Strength', 'Defence'].includes(String(data.skill))) {
                throw new Error('directive.skill must be Attack, Strength, or Defence');
            }
            return {
                type: 'set_combat_style',
                skill: data.skill as 'Attack' | 'Strength' | 'Defence',
            };
        case 'wait':
            return { type: 'wait', ticks: integer(data.ticks, 'directive.ticks', 1, 20) };
        default:
            throw new Error(`Unhandled directive ${data.type}`);
    }
}

function completion(value: unknown): CompletionCondition {
    const data = record(value, 'completion');
    if (typeof data.type !== 'string' || !COMPLETION_TYPES.has(data.type)) throw new Error('completion.type is invalid');
    switch (data.type) {
        case 'action_success':
        case 'dialog_open':
        case 'dialog_closed':
        case 'interface_open':
        case 'interface_closed':
            return { type: data.type };
        case 'position':
            return {
                type: 'position',
                x: integer(data.x, 'completion.x', 0, 16_383),
                z: integer(data.z, 'completion.z', 0, 16_383),
                tolerance: integer(data.tolerance, 'completion.tolerance', 0, 20),
            };
        case 'inventory':
            return {
                type: 'inventory',
                item: string(data.item, 'completion.item', 80),
                count: integer(data.count, 'completion.count', 1, 100_000),
            };
        case 'skill_level':
            return {
                type: 'skill_level',
                skill: string(data.skill, 'completion.skill', 40),
                level: integer(data.level, 'completion.level', 1, 99),
            };
        case 'skill_xp_delta':
            return {
                type: 'skill_xp_delta',
                skill: string(data.skill, 'completion.skill', 40),
                delta: integer(data.delta, 'completion.delta', 1, 100_000_000),
            };
        default:
            throw new Error(`Unhandled completion ${data.type}`);
    }
}

function workflow(value: unknown): OperatorWorkflow | null {
    if (value === null) return null;
    const data = record(value, 'workflow');
    if (!Array.isArray(data.steps) || data.steps.length < 1 || data.steps.length > 30) {
        throw new Error('workflow.steps must contain 1-30 entries');
    }
    const seen = new Set<string>();
    const steps = data.steps.map((entry, index): OperatorWorkflowStep => {
        const step = record(entry, `workflow.steps[${index}]`);
        const id = string(step.id, `workflow.steps[${index}].id`, 50);
        if (seen.has(id)) throw new Error(`duplicate workflow step id '${id}'`);
        seen.add(id);
        return {
            id,
            description: string(step.description, `workflow.steps[${index}].description`, 180),
            directive: directive(step.directive),
            completion: completion(step.completion),
            repeatUntilComplete: Boolean(step.repeatUntilComplete),
            maxAttempts: integer(step.maxAttempts, `workflow.steps[${index}].maxAttempts`, 1, 100),
        };
    });
    return {
        name: string(data.name, 'workflow.name', 80),
        goal: string(data.goal, 'workflow.goal', 200),
        reusable: Boolean(data.reusable),
        version: integer(data.version, 'workflow.version', 1, 1000),
        successCriteria: stringArray(data.successCriteria, 'workflow.successCriteria', 10),
        steps,
    };
}

export function parseOperatorDecision(value: unknown): OperatorDecision {
    const data = record(value, 'operator decision');
    if (!Array.isArray(data.blockers) || data.blockers.length > 10) throw new Error('blockers must contain at most 10 entries');
    const blockers = data.blockers.map((entry, index): OperatorBlocker => {
        const blocker = record(entry, `blockers[${index}]`);
        if (typeof blocker.kind !== 'string' || !BLOCKER_KINDS.has(blocker.kind)) throw new Error('blocker.kind is invalid');
        if (typeof blocker.severity !== 'string' || !SEVERITIES.has(blocker.severity)) throw new Error('blocker.severity is invalid');
        return {
            kind: blocker.kind as OperatorBlockerKind,
            target: string(blocker.target, `blockers[${index}].target`, 120),
            evidence: string(blocker.evidence, `blockers[${index}].evidence`, 220),
            severity: blocker.severity as OperatorBlocker['severity'],
        };
    });

    let escalation: OperatorEscalation | null = null;
    if (data.escalation !== null) {
        const item = record(data.escalation, 'escalation');
        if (typeof item.reason !== 'string' || !ESCALATION_REASONS.has(item.reason)) {
            throw new Error('escalation.reason is invalid');
        }
        escalation = {
            reason: item.reason as OperatorEscalation['reason'],
            question: string(item.question, 'escalation.question', 240),
            evidence: stringArray(item.evidence, 'escalation.evidence', 10),
            suggestedOptions: stringArray(item.suggestedOptions, 'escalation.suggestedOptions', 6),
        };
    }

    const parsedWorkflow = workflow(data.workflow);
    if (!parsedWorkflow && !escalation) throw new Error('operator decision requires a workflow or escalation');
    if (
        parsedWorkflow &&
        parsedWorkflow.steps.every(step => step.directive.type === 'wait') &&
        !escalation
    ) {
        throw new Error('wait-only workflows are not allowed; choose productive work or escalate');
    }
    return {
        summary: string(data.summary, 'summary', 400),
        goal: goal(data.goal),
        blockers,
        workflow: parsedWorkflow,
        escalation,
    };
}

export function parseOperatorDecisionText(text: string): OperatorDecision {
    const normalized = text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
    try {
        return parseOperatorDecision(JSON.parse(normalized));
    } catch (directError) {
        const start = normalized.indexOf('{');
        const end = normalized.lastIndexOf('}');
        if (start < 0 || end <= start) throw directError;
        return parseOperatorDecision(JSON.parse(normalized.slice(start, end + 1)));
    }
}
