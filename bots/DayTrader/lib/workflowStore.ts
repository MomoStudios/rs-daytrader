import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { OperatorWorkflow } from './operatorSchema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const WORKFLOWS_PATH = join(DATA_DIR, 'workflows.json');
const TEMP_PATH = `${WORKFLOWS_PATH}.tmp`;

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
    if (!existsSync(WORKFLOWS_PATH)) return { workflows: [] };
    try {
        return JSON.parse(readFileSync(WORKFLOWS_PATH, 'utf8')) as WorkflowRegistry;
    } catch (error) {
        console.warn(`[workflowStore] Could not read workflow registry: ${error}`);
        return { workflows: [] };
    }
}

function persist(registry: WorkflowRegistry): void {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TEMP_PATH, JSON.stringify(registry, null, 2));
    renameSync(TEMP_PATH, WORKFLOWS_PATH);
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
