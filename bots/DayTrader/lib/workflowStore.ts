import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { OperatorWorkflow } from './operatorSchema';

const __dirname = dirname(fileURLToPath(import.meta.url));
let dataDir = join(__dirname, '..', 'data');

function workflowsPath(): string {
    return join(dataDir, 'workflows.json');
}

function tempPath(): string {
    return `${workflowsPath()}.tmp`;
}

/**
 * Test-only hook: redirect the on-disk registry to an isolated directory so
 * candidate-promotion tests never write into the real runtime data folder.
 * Never called from production code paths.
 */
export function _setWorkflowsDataDirForTests(dir: string): void {
    dataDir = dir;
}

export interface StoredWorkflow {
    id: string;
    hash: string;
    createdAt: number;
    updatedAt: number;
    workflow: OperatorWorkflow;
}

interface WorkflowRegistry {
    workflows: StoredWorkflow[];
}

function loadRegistry(): WorkflowRegistry {
    if (!existsSync(workflowsPath())) return { workflows: [] };
    try {
        return JSON.parse(readFileSync(workflowsPath(), 'utf8')) as WorkflowRegistry;
    } catch (error) {
        console.warn(`[workflowStore] Could not read workflow registry: ${error}`);
        return { workflows: [] };
    }
}

function persist(registry: WorkflowRegistry): void {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(tempPath(), JSON.stringify(registry, null, 2));
    renameSync(tempPath(), workflowsPath());
}

export function workflowHash(workflow: OperatorWorkflow): string {
    return createHash('sha256').update(JSON.stringify(workflow)).digest('hex').slice(0, 16);
}

export function storeReusableWorkflow(workflow: OperatorWorkflow): StoredWorkflow | null {
    if (!workflow.reusable) return null;
    const registry = loadRegistry();
    const hash = workflowHash(workflow);
    const id = workflow.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const now = Date.now();
    const existing = registry.workflows.find(item => item.id === id);
    const stored: StoredWorkflow = {
        id,
        hash,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        workflow,
    };
    if (existing) Object.assign(existing, stored);
    else registry.workflows.push(stored);
    if (registry.workflows.length > 100) {
        registry.workflows.sort((a, b) => b.updatedAt - a.updatedAt);
        registry.workflows.length = 100;
    }
    persist(registry);
    return stored;
}

export function listReusableWorkflows(): StoredWorkflow[] {
    return loadRegistry().workflows;
}

export function getReusableWorkflow(id: string): StoredWorkflow | null {
    return loadRegistry().workflows.find(item => item.id === id) ?? null;
}

/**
 * Removes a previously-promoted workflow from the production registry.
 * Used when a workflow candidate is rolled back after promotion turns out
 * to be unsafe or unreliable in later executions.
 */
export function removeReusableWorkflow(id: string): boolean {
    const registry = loadRegistry();
    const before = registry.workflows.length;
    registry.workflows = registry.workflows.filter(item => item.id !== id);
    if (registry.workflows.length === before) return false;
    persist(registry);
    return true;
}
