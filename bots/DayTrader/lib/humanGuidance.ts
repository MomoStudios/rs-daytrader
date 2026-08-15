import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const GUIDANCE_PATH = join(DATA_DIR, 'human-guidance.json');
const TEMP_PATH = `${GUIDANCE_PATH}.tmp`;

export interface HumanGuidance {
    id: string;
    text: string;
    status: 'pending' | 'applied' | 'resolved';
    createdAt: number;
    appliedAt: number | null;
    appliedSummary: string | null;
}

interface GuidanceFile {
    instructions: HumanGuidance[];
}

function load(): GuidanceFile {
    if (!existsSync(GUIDANCE_PATH)) return { instructions: [] };
    try {
        return JSON.parse(readFileSync(GUIDANCE_PATH, 'utf8')) as GuidanceFile;
    } catch (error) {
        console.warn(`[humanGuidance] Could not read guidance: ${error}`);
        return { instructions: [] };
    }
}

function save(value: GuidanceFile): void {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TEMP_PATH, JSON.stringify(value, null, 2));
    renameSync(TEMP_PATH, GUIDANCE_PATH);
}

export function normalizeHumanGuidance(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > 1_000) {
        throw new Error('Instruction must contain 1-1000 characters');
    }
    return normalized;
}

export function addHumanGuidance(text: string): HumanGuidance {
    const normalized = normalizeHumanGuidance(text);
    const value = load();
    const instruction: HumanGuidance = {
        id: `human-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: normalized,
        status: 'pending',
        createdAt: Date.now(),
        appliedAt: null,
        appliedSummary: null,
    };
    value.instructions.push(instruction);
    if (value.instructions.length > 100) {
        value.instructions.splice(0, value.instructions.length - 100);
    }
    save(value);
    return instruction;
}

export function listHumanGuidance(): HumanGuidance[] {
    return load().instructions;
}

export function pendingHumanGuidance(limit = 5): HumanGuidance[] {
    return load()
        .instructions.filter(instruction => instruction.status === 'pending')
        .slice(-limit);
}

export function markHumanGuidanceApplied(ids: string[], summary: string): void {
    if (ids.length === 0) return;
    const value = load();
    const selected = new Set(ids);
    for (const instruction of value.instructions) {
        if (!selected.has(instruction.id) || instruction.status !== 'pending') continue;
        instruction.status = 'applied';
        instruction.appliedAt = Date.now();
        instruction.appliedSummary = summary;
    }
    save(value);
}
