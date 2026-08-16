import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { _resetRegistryForTests } from '../lib/registryDb';
import { _setWorkflowsDataDirForTests, listReusableWorkflows, workflowHash } from '../lib/workflowStore';
import {
    getWorkflowCandidate,
    getWorkflowCandidateByHash,
    listWorkflowCandidates,
    listCanaryWorkflowOptions,
    proposeWorkflowCandidate,
    recordWorkflowCandidateOutcome,
    rejectWorkflowCandidate,
    rollbackWorkflowCandidate,
    validateWorkflowCandidateStatically,
} from '../lib/workflowCandidateStore';
import type { OperatorWorkflow } from '../lib/operatorSchema';
import type { MaterialReservation } from '../lib/aiDecision';
import type { AssetMemory } from '../lib/assetMemory';

const DATA_DIR = join(import.meta.dir, '..', 'data');
let tempDir: string;

beforeEach(() => {
    _resetRegistryForTests(':memory:');
    tempDir = mkdtempSync(join(DATA_DIR, 'candidate-test-'));
    _setWorkflowsDataDirForTests(tempDir);
});

afterEach(() => {
    _resetRegistryForTests(':memory:');
    _setWorkflowsDataDirForTests(join(import.meta.dir, '..', 'data'));
    rmSync(tempDir, { recursive: true, force: true });
});

function workflow(overrides: Partial<OperatorWorkflow> = {}): OperatorWorkflow {
    return {
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
        ...overrides,
    };
}

describe('workflow candidate - static validation', () => {
    test('accepts a structurally valid workflow', () => {
        const result = validateWorkflowCandidateStatically(workflow());
        expect(result.ok).toBe(true);
    });

    test('rejects a workflow that violates a material reservation', () => {
        const reservations: MaterialReservation[] = [
            { item: 'Iron bar', count: 5, purpose: 'iron platebody order' },
        ];
        const assets: AssetMemory = {
            inventory: [{ name: 'Iron bar', count: 5 }],
            equipment: [],
            bank: [],
            inventoryObservedAt: Date.now(),
            bankObservedAt: null,
            bankObservationSource: 'never_observed',
            combinedHoldings: [{ name: 'Iron bar', count: 5 }],
        };
        const smithing = workflow({
            name: 'smith-dagger',
            steps: [
                {
                    id: 'smith',
                    description: 'Smith an iron dagger.',
                    directive: { type: 'smith_product', product: 'Iron dagger', bar: 'Iron bar' },
                    completion: { type: 'action_success' },
                    repeatUntilComplete: false,
                    maxAttempts: 3,
                },
            ],
        });

        const result = validateWorkflowCandidateStatically(smithing, reservations, assets);
        expect(result.ok).toBe(false);
        expect(result.notes.some(note => note.includes('reservation violation'))).toBe(true);
    });

    test('rejects an incompatible directive and completion contract', () => {
        const invalid = workflow({
            steps: [{
                id: 'walk',
                description: 'Walk somewhere.',
                directive: { type: 'walk_to', x: 3200, z: 3200, tolerance: 2 },
                completion: { type: 'inventory', item: 'Runite ore', count: 1 },
                repeatUntilComplete: false,
                maxAttempts: 3,
            }],
        });
        const result = validateWorkflowCandidateStatically(invalid);
        expect(result.ok).toBe(false);
        expect(result.notes[0]).toContain('incompatible');
    });
});

describe('workflow candidate - proposal lifecycle', () => {
    test('a structurally valid proposal starts statically_verified, not promoted', () => {
        const candidate = proposeWorkflowCandidate({ workflow: workflow(), source: 'operator_plan' });
        expect(candidate.status).toBe('statically_verified');
        expect(listReusableWorkflows()).toEqual([]);
    });

    test('proposing the same workflow content twice reuses the same candidate row (hash identity)', () => {
        const first = proposeWorkflowCandidate({ workflow: workflow(), source: 'operator_plan' });
        const second = proposeWorkflowCandidate({ workflow: workflow(), source: 'operator_plan' });
        expect(second.id).toBe(first.id);
        expect(listWorkflowCandidates().length).toBe(1);
    });

    test('an invalid proposal (reservation violation) is rejected immediately, never touching production registry', () => {
        const reservations: MaterialReservation[] = [{ item: 'Iron bar', count: 5, purpose: 'order' }];
        const assets: AssetMemory = {
            inventory: [{ name: 'Iron bar', count: 5 }],
            equipment: [],
            bank: [],
            inventoryObservedAt: Date.now(),
            bankObservedAt: null,
            bankObservationSource: 'never_observed',
            combinedHoldings: [{ name: 'Iron bar', count: 5 }],
        };
        const smithing = workflow({
            name: 'smith-dagger',
            steps: [
                {
                    id: 'smith',
                    description: 'Smith an iron dagger.',
                    directive: { type: 'smith_product', product: 'Iron dagger', bar: 'Iron bar' },
                    completion: { type: 'action_success' },
                    repeatUntilComplete: false,
                    maxAttempts: 3,
                },
            ],
        });
        const candidate = proposeWorkflowCandidate({
            workflow: smithing,
            source: 'development_review',
            materialReservations: reservations,
            assetMemory: assets,
        });
        expect(candidate.status).toBe('rejected');
        expect(listReusableWorkflows()).toEqual([]);
    });

    test('development review proposals never land directly in the production registry', () => {
        proposeWorkflowCandidate({ workflow: workflow(), source: 'development_review', relatedReviewId: 'devreview-1' });
        expect(listReusableWorkflows()).toEqual([]);
        expect(listCanaryWorkflowOptions().map(item => item.workflow.name)).toEqual(['mine-runite']);
    });
});

describe('workflow candidate - canary and promotion', () => {
    test('promotes only after enough canary successes, and writes to the production registry exactly once', () => {
        const w = workflow();
        const hash = workflowHash(w);
        proposeWorkflowCandidate({ workflow: w, source: 'operator_plan' });

        const afterFirstSuccess = recordWorkflowCandidateOutcome(hash, 'success');
        expect(afterFirstSuccess?.status).toBe('canary');
        expect(listReusableWorkflows()).toEqual([]);

        const afterSecondSuccess = recordWorkflowCandidateOutcome(hash, 'success');
        expect(afterSecondSuccess?.status).toBe('promoted');
        expect(afterSecondSuccess?.promotedWorkflowId).toBeTruthy();
        expect(listReusableWorkflows().length).toBe(1);
    });

    test('a failure during canary rejects the candidate and never promotes it', () => {
        const w = workflow({ name: 'flaky-workflow' });
        const hash = workflowHash(w);
        proposeWorkflowCandidate({ workflow: w, source: 'operator_plan' });
        recordWorkflowCandidateOutcome(hash, 'success');
        const afterFailure = recordWorkflowCandidateOutcome(hash, 'failure', 'stalled during second canary run');
        expect(afterFailure?.status).toBe('rejected');
        expect(listReusableWorkflows()).toEqual([]);
    });

    test('a failure after promotion rolls the workflow back out of the production registry', () => {
        const w = workflow({ name: 'later-unreliable' });
        const hash = workflowHash(w);
        proposeWorkflowCandidate({ workflow: w, source: 'operator_plan' });
        recordWorkflowCandidateOutcome(hash, 'success');
        recordWorkflowCandidateOutcome(hash, 'success');
        expect(listReusableWorkflows().length).toBe(1);

        const afterFailure = recordWorkflowCandidateOutcome(hash, 'failure', 'broke after a game update');
        expect(afterFailure?.status).toBe('rolled_back');
        expect(listReusableWorkflows()).toEqual([]);
    });

    test('recording an outcome for an unknown hash returns null instead of throwing', () => {
        expect(recordWorkflowCandidateOutcome('does-not-exist', 'success')).toBeNull();
    });

    test('a lower canary threshold promotes after a single success', () => {
        const w = workflow({ name: 'quick-promote' });
        const hash = workflowHash(w);
        proposeWorkflowCandidate({ workflow: w, source: 'operator_plan' });
        const result = recordWorkflowCandidateOutcome(hash, 'success', undefined, 1);
        expect(result?.status).toBe('promoted');
    });
});

describe('workflow candidate - manual reject/rollback', () => {
    test('rejectWorkflowCandidate marks a candidate rejected with a reason', () => {
        const candidate = proposeWorkflowCandidate({ workflow: workflow(), source: 'operator_plan' });
        const rejected = rejectWorkflowCandidate(candidate.id, 'superseded by a better workflow');
        expect(rejected.status).toBe('rejected');
        expect(rejected.validationNotes.at(-1)).toBe('superseded by a better workflow');
    });

    test('rollbackWorkflowCandidate on a promoted candidate removes it from production', () => {
        const w = workflow({ name: 'to-be-rolled-back' });
        const hash = workflowHash(w);
        const candidate = proposeWorkflowCandidate({ workflow: w, source: 'operator_plan' });
        recordWorkflowCandidateOutcome(hash, 'success');
        recordWorkflowCandidateOutcome(hash, 'success');
        expect(listReusableWorkflows().length).toBe(1);
        const rolledBack = rollbackWorkflowCandidate(candidate.id, 'manual rollback for safety review');
        expect(rolledBack.status).toBe('rolled_back');
        expect(listReusableWorkflows()).toEqual([]);
    });

    test('throws when transitioning an unknown candidate id', () => {
        expect(() => rejectWorkflowCandidate('candidate-missing', 'n/a')).toThrow();
        expect(() => rollbackWorkflowCandidate('candidate-missing', 'n/a')).toThrow();
    });
});

describe('workflow candidate - lookups', () => {
    test('getWorkflowCandidateByHash finds the row proposeWorkflowCandidate created', () => {
        const w = workflow();
        const created = proposeWorkflowCandidate({ workflow: w, source: 'operator_plan' });
        const found = getWorkflowCandidateByHash(workflowHash(w));
        expect(found?.id).toBe(created.id);
        expect(getWorkflowCandidate(created.id)?.id).toBe(created.id);
    });

    test('listWorkflowCandidates filters by status and source', () => {
        proposeWorkflowCandidate({ workflow: workflow({ name: 'a' }), source: 'operator_plan' });
        proposeWorkflowCandidate({ workflow: workflow({ name: 'b' }), source: 'development_review' });
        expect(listWorkflowCandidates({ source: 'development_review' }).length).toBe(1);
        expect(listWorkflowCandidates({ status: 'statically_verified' }).length).toBe(2);
    });
});
