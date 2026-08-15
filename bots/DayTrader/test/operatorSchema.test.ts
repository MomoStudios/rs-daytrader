import { describe, expect, test } from 'bun:test';
import {
    parseOperatorDecision,
    parseOperatorDecisionText,
} from '../lib/operatorSchema';

const valid = {
    summary: 'Train mining before pursuing runite access.',
    goal: {
        kind: 'leveling',
        target: 'Mining level 85',
        targetValue: 85,
        rationale: 'Runite ore requires Mining 85.',
    },
    blockers: [
        {
            kind: 'skill',
            target: 'Mining 85',
            evidence: 'Current Mining level is 20.',
            severity: 'high',
        },
    ],
    workflow: {
        name: 'train-mining-to-85',
        goal: 'Reach Mining 85',
        reusable: true,
        version: 1,
        successCriteria: ['Mining level is at least 85'],
        steps: [
            {
                id: 'train-mining',
                description: 'Run bounded mining actions until level 85.',
                directive: {
                    type: 'strategic_action',
                    action: { type: 'train', activity: 'mining' },
                },
                completion: { type: 'skill_level', skill: 'Mining', level: 85 },
                repeatUntilComplete: true,
                maxAttempts: 100,
            },
        ],
    },
    escalation: null,
};

describe('operator decision boundary', () => {
    test('accepts a bounded reusable workflow', () => {
        expect(parseOperatorDecision(valid).workflow?.steps[0]?.directive.type).toBe('strategic_action');
    });

    test('rejects code execution directives', () => {
        expect(() =>
            parseOperatorDecision({
                ...valid,
                workflow: {
                    ...valid.workflow,
                    steps: [
                        {
                            ...valid.workflow.steps[0],
                            directive: { type: 'run_code', code: 'await bot.walkTo(1, 1)' },
                        },
                    ],
                },
            })
        ).toThrow('directive.type is invalid');
    });

    test('rejects unbounded workflows', () => {
        expect(() =>
            parseOperatorDecision({
                ...valid,
                workflow: {
                    ...valid.workflow,
                    steps: Array.from({ length: 31 }, (_, index) => ({
                        ...valid.workflow.steps[0],
                        id: `step-${index}`,
                    })),
                },
            })
        ).toThrow('1-30');
    });

    test('allows a strategic escalation without a workflow', () => {
        const decision = parseOperatorDecision({
            ...valid,
            workflow: null,
            escalation: {
                reason: 'competition',
                question: 'Runite rocks are continuously contested; keep trying or pursue another stock item?',
                evidence: ['Five nearby players', 'No ore gained in ten attempts'],
                suggestedOptions: ['Try another mine', 'Switch to another demanded resource'],
            },
        });
        expect(decision.escalation?.reason).toBe('competition');
    });

    test('allows safe blocking-UI recovery workflows', () => {
        const decision = parseOperatorDecision({
            ...valid,
            workflow: {
                ...valid.workflow,
                steps: [
                    {
                        id: 'clear-ui',
                        description: 'Dismiss a level-up modal.',
                        directive: { type: 'dismiss_blocking_ui' },
                        completion: { type: 'dialog_closed' },
                        repeatUntilComplete: false,
                        maxAttempts: 2,
                    },
                ],
            },
        });
        expect(decision.workflow?.steps[0]?.directive.type).toBe('dismiss_blocking_ui');
    });

    test('rejects indefinite wait-only workflows', () => {
        expect(() =>
            parseOperatorDecision({
                ...valid,
                workflow: {
                    ...valid.workflow,
                    steps: [
                        {
                            id: 'wait',
                            description: 'Wait without a concrete reason.',
                            directive: { type: 'wait', ticks: 20 },
                            completion: { type: 'action_success' },
                            repeatUntilComplete: true,
                            maxAttempts: 100,
                        },
                    ],
                },
            })
        ).toThrow('wait-only workflows');
    });

    test('allows combat style and equipment directives', () => {
        const parsed = parseOperatorDecision({
            ...valid,
            workflow: {
                ...valid.workflow,
                steps: [
                    {
                        id: 'equip',
                        description: 'Equip an owned sword.',
                        directive: { type: 'equip_item', item: 'Bronze sword' },
                        completion: { type: 'action_success' },
                        repeatUntilComplete: false,
                        maxAttempts: 2,
                    },
                    {
                        id: 'style',
                        description: 'Select a style that trains Defence.',
                        directive: { type: 'set_combat_style', skill: 'Defence' },
                        completion: { type: 'action_success' },
                        repeatUntilComplete: false,
                        maxAttempts: 2,
                    },
                ],
            },
        });
        expect(parsed.workflow?.steps.map(step => step.directive.type)).toEqual([
            'equip_item',
            'set_combat_style',
        ]);
    });

    test('extracts valid JSON wrapped in model prose', () => {
        const parsed = parseOperatorDecisionText(
            `Here is the workflow:\n${JSON.stringify(valid)}\nExecution can begin now.`
        );
        expect(parsed.workflow?.name).toBe('train-mining-to-85');
    });

    test('allows explicit smithing product selection', () => {
        const parsed = parseOperatorDecision({
            ...valid,
            workflow: {
                ...valid.workflow,
                steps: [
                    {
                        id: 'smith-helm',
                        description: 'Smith one bronze med helm.',
                        directive: {
                            type: 'smith_product',
                            product: 'med helm',
                            bar: 'Bronze bar',
                        },
                        completion: {
                            type: 'inventory',
                            item: 'Bronze med helm',
                            count: 1,
                        },
                        repeatUntilComplete: true,
                        maxAttempts: 5,
                    },
                ],
            },
        });
        expect(parsed.workflow?.steps[0]?.directive.type).toBe('smith_product');
    });
});
