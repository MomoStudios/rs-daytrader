import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { AiDecision, StrategicGoal } from './aiDecision';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const STRATEGY_PATH = join(DATA_DIR, 'strategy.json');
const TEMP_PATH = `${STRATEGY_PATH}.tmp`;

export interface StrategyState {
    currentGoal: StrategicGoal | null;
    lastDecision: AiDecision | null;
    lastPlannedAt: number;
    recentActionResults: Array<{
        at: number;
        action: string;
        success: boolean;
        message: string;
    }>;
}

function defaultState(): StrategyState {
    return {
        currentGoal: null,
        lastDecision: null,
        lastPlannedAt: 0,
        recentActionResults: [],
    };
}

let state: StrategyState | null = null;

export function loadStrategy(): StrategyState {
    if (state) return state;
    if (!existsSync(STRATEGY_PATH)) {
        state = defaultState();
        return state;
    }
    try {
        const parsed = JSON.parse(readFileSync(STRATEGY_PATH, 'utf8')) as Partial<StrategyState>;
        const lastDecision = parsed.lastDecision
            ? {
                  ...parsed.lastDecision,
                  marketSignals: parsed.lastDecision.marketSignals ?? [],
                  chatActions: parsed.lastDecision.chatActions ?? [],
              }
            : null;
        state = { ...defaultState(), ...parsed, lastDecision };
    } catch (error) {
        console.warn(`[strategyStore] Could not read strategy state: ${error}`);
        state = defaultState();
    }
    return state;
}

function persist(): void {
    if (!state) return;
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TEMP_PATH, JSON.stringify(state, null, 2));
    renameSync(TEMP_PATH, STRATEGY_PATH);
}

export function recordDecision(decision: AiDecision): void {
    const current = loadStrategy();
    current.currentGoal = decision.goal;
    current.lastDecision = decision;
    current.lastPlannedAt = Date.now();
    persist();
}

export function recordActionResult(action: string, success: boolean, message: string): void {
    const current = loadStrategy();
    current.recentActionResults.push({ at: Date.now(), action, success, message });
    if (current.recentActionResults.length > 20) {
        current.recentActionResults.splice(0, current.recentActionResults.length - 20);
    }
    persist();
}
