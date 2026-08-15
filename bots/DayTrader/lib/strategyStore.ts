import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { AiDecision, StrategicGoal } from './aiDecision';
import type { MarketSignal } from './aiDecision';
import type { MaterialReservation } from './aiDecision';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const STRATEGY_PATH = join(DATA_DIR, 'strategy.json');
const TEMP_PATH = `${STRATEGY_PATH}.tmp`;

export interface StrategyState {
    currentGoal: StrategicGoal | null;
    lastDecision: AiDecision | null;
    lastPlannedAt: number;
    goalHistory: Array<{
        goal: StrategicGoal;
        summary: string;
        at: number;
    }>;
    marketMemory: Array<MarketSignal & { firstSeenAt: number; lastSeenAt: number; observations: number }>;
    completedGoals: Array<{
        goal: StrategicGoal;
        completedAt: number;
        evidence: string;
    }>;
    materialReservations: MaterialReservation[];
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
        goalHistory: [],
        marketMemory: [],
        completedGoals: [],
        materialReservations: [],
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
                  reservations: parsed.lastDecision.reservations ?? [],
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
    current.materialReservations = decision.reservations ?? [];
    current.lastPlannedAt = Date.now();
    const previousGoal = current.goalHistory.at(-1)?.goal;
    if (
        !previousGoal ||
        previousGoal.kind !== decision.goal.kind ||
        previousGoal.target.toLowerCase() !== decision.goal.target.toLowerCase() ||
        previousGoal.targetValue !== decision.goal.targetValue
    ) {
        current.goalHistory.push({
            goal: decision.goal,
            summary: decision.summary,
            at: Date.now(),
        });
        if (current.goalHistory.length > 100) {
            current.goalHistory.splice(0, current.goalHistory.length - 100);
        }
    }
    for (const signal of decision.marketSignals ?? []) {
        const existing = current.marketMemory.find(
            item =>
                item.kind === signal.kind &&
                item.topic.toLowerCase() === signal.topic.toLowerCase()
        );
        if (existing) {
            existing.lastSeenAt = Date.now();
            existing.observations += 1;
            existing.confidence = Math.max(existing.confidence, signal.confidence);
            existing.evidence = signal.evidence;
            existing.implication = signal.implication;
            existing.participants = [...new Set([...existing.participants, ...signal.participants])].slice(0, 10);
        } else {
            current.marketMemory.push({
                ...signal,
                firstSeenAt: Date.now(),
                lastSeenAt: Date.now(),
                observations: 1,
            });
        }
    }
    if (current.marketMemory.length > 100) {
        current.marketMemory
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
            .splice(100);
    }
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

export function recordGoalCompletion(goal: StrategicGoal, evidence: string): void {
    const current = loadStrategy();
    const duplicate = current.completedGoals.some(
        entry =>
            entry.goal.kind === goal.kind &&
            entry.goal.target.toLowerCase() === goal.target.toLowerCase() &&
            entry.goal.targetValue === goal.targetValue
    );
    if (!duplicate) {
        current.completedGoals.push({ goal, completedAt: Date.now(), evidence });
        if (current.completedGoals.length > 100) {
            current.completedGoals.splice(0, current.completedGoals.length - 100);
        }
    }
    persist();
}
