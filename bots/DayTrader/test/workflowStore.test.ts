import { describe, expect, test } from 'bun:test';
import { workflowHash } from '../lib/workflowStore';
import type { OperatorWorkflow } from '../lib/operatorSchema';

const workflow: OperatorWorkflow = {
    name: 'mine-runite',
    goal: 'Acquire runite ore',
    reusable: true,
    version: 1,
    successCriteria: ['Hold one runite ore'],
    steps: [
        {
            id: 'mine',
            description: 'Mine a visible runite rock.',
            directive: { type: 'interact_loc', target: 'Rocks runite ore', option: 'Mine' },
            completion: { type: 'inventory', item: 'Runite ore', count: 1 },
            repeatUntilComplete: true,
            maxAttempts: 20,
        },
    ],
};

describe('declarative workflow storage', () => {
    test('hashes identical workflows deterministically', () => {
        expect(workflowHash(workflow)).toBe(workflowHash(structuredClone(workflow)));
    });

    test('changes the hash when workflow semantics change', () => {
        const changed = structuredClone(workflow);
        changed.steps[0]!.maxAttempts = 21;
        expect(workflowHash(changed)).not.toBe(workflowHash(workflow));
    });
});
