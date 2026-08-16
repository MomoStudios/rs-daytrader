import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { listIssues, type IssueSeverity } from './issueRegistry';
import { computeRegistryMetrics, type RegistryMetrics } from './registryMetrics';
import { readRuntimeHeartbeat, type RuntimeHeartbeat } from './runtimeHealth';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DECISIONS_PATH = join(DATA_DIR, 'decisions.jsonl');

export interface TraceEvent {
    ts: number;
    type: string;
    [key: string]: unknown;
}

export interface GameTraceSummary {
    window: {
        startTs: number;
        endTs: number;
        eventCount: number;
        hours: number;
    };
    current: {
        strategy: unknown;
        operator: unknown;
        state: unknown;
        collection: unknown;
        guidance: unknown;
        runtimeHealth: {
            mainLoop: RuntimeHeartbeat | null;
            developmentReviewer: RuntimeHeartbeat | null;
            maintenanceWorker: RuntimeHeartbeat | null;
        };
    };
    counts: Record<string, number>;
    outcomes: {
        successfulTrades: number;
        failedTrades: number;
        estimatedTradeProfitGp: number;
        successfulSteps: number;
        failedSteps: number;
        stalls: number;
        escalations: number;
        aiErrors: number;
    };
    repeatedFailures: Array<{ message: string; count: number }>;
    timeline: TraceEvent[];
    /** Unresolved systemic issues the development reviewer should weigh in
     *  on - deliberately bounded and summarized, not the full registry. */
    systemicIssues: Array<{
        id: string;
        category: string;
        ownerLayer: string;
        severity: string;
        status: string;
        title: string;
        attempts: number;
        recurrenceCount: number;
        ageMs: number;
    }>;
    registryMetrics: RegistryMetrics;
}

function readJson(name: string): unknown {
    const path = join(DATA_DIR, name);
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        return { error: String(error) };
    }
}

export function sanitizePersistentStateValue(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const state = value as Record<string, unknown>;
    return {
        ...state,
        scamRecords: Array.isArray(state.scamRecords)
            ? state.scamRecords.map(record => {
                  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
                      return record;
                  }
                  const { text: _rawChat, ...safe } = record as Record<string, unknown>;
                  return safe;
              })
            : [],
    };
}

function sanitizedPersistentState(): unknown {
    return sanitizePersistentStateValue(readJson('state.json'));
}
function recentEvents(hours: number, maxEvents: number, maxBytes = 48 * 1024 * 1024): TraceEvent[] {
    if (!existsSync(DECISIONS_PATH)) return [];
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const size = statSync(DECISIONS_PATH).size;
    const bytes = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(bytes);
    const fd = openSync(DECISIONS_PATH, 'r');
    try {
        readSync(fd, buffer, 0, bytes, size - bytes);
    } finally {
        closeSync(fd);
    }

    const lines = buffer.toString('utf8').split('\n');
    if (size > bytes) lines.shift();
    const events: TraceEvent[] = [];
    for (const line of lines) {
        if (!line) continue;
        try {
            const event = JSON.parse(line) as TraceEvent;
            if (typeof event.ts !== 'number' || event.ts < cutoff) continue;
            // Raw game/player text is deliberately excluded from development
            // traces. Market interpretation is represented by strategist
            // signals, while failures retain deterministic messages.
            delete event.text;
            events.push(event);
        } catch {
            // Ignore a truncated/corrupt JSONL record.
        }
    }
    return events.slice(-maxEvents);
}

function conciseEvent(event: TraceEvent): TraceEvent {
    const allowedByType: Record<string, string[]> = {
        ai_plan: ['summary', 'goal', 'marketSignals', 'nextAction'],
        operator_plan: ['summary', 'mode', 'blockers', 'workflow', 'escalation'],
        operator_step: ['action', 'success', 'message'],
        operator_stall: ['workflow', 'step', 'attempts', 'stall', 'actionResult'],
        operator_escalation: ['reason', 'question', 'evidence', 'suggestedOptions'],
        trade_result: ['requester', 'success', 'message', 'gave', 'received', 'netProfitGp'],
        trade_decision: ['sender', 'requester', 'accept', 'reason', 'myOfferValue', 'theirOfferValue'],
        skill_action: ['action', 'activity', 'success', 'message', 'item'],
        character_trace: ['player', 'skills', 'inventory', 'equipment', 'combat', 'ui'],
        ai_error: ['stage', 'error'],
        error: ['stage', 'error'],
        ad_sent: ['message', 'style'],
    };
    const keys = allowedByType[event.type] ?? [];
    const concise: TraceEvent = { ts: event.ts, type: event.type };
    for (const key of keys) {
        if (key in event) concise[key] = event[key];
    }
    return concise;
}

const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

function summarizeSystemicIssues(limit = 30): GameTraceSummary['systemicIssues'] {
    const now = Date.now();
    return listIssues({ openOnly: true, limit: 500 })
        .sort(
            (a, b) =>
                SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.firstDetectedAt - b.firstDetectedAt
        )
        .slice(0, limit)
        .map(issue => ({
            id: issue.id,
            category: issue.category,
            ownerLayer: issue.ownerLayer,
            severity: issue.severity,
            status: issue.status,
            title: issue.title,
            attempts: issue.attempts,
            recurrenceCount: issue.recurrenceCount,
            ageMs: now - issue.firstDetectedAt,
        }));
}

export function buildGameTrace(hours = 4, maxEvents = 4_000): GameTraceSummary {
    const events = recentEvents(hours, maxEvents);
    const counts: Record<string, number> = {};
    const failures = new Map<string, number>();
    let successfulTrades = 0;
    let failedTrades = 0;
    let estimatedTradeProfitGp = 0;
    let successfulSteps = 0;
    let failedSteps = 0;
    let stalls = 0;
    let escalations = 0;
    let aiErrors = 0;

    for (const event of events) {
        counts[event.type] = (counts[event.type] ?? 0) + 1;
        if (event.type === 'trade_result') {
            if (event.success) successfulTrades += 1;
            else failedTrades += 1;
            if (typeof event.netProfitGp === 'number') estimatedTradeProfitGp += event.netProfitGp;
        }
        if (event.type === 'operator_step' || event.type === 'skill_action') {
            if (event.success) successfulSteps += 1;
            else {
                failedSteps += 1;
                const message = String(event.message ?? 'unknown failure');
                failures.set(message, (failures.get(message) ?? 0) + 1);
            }
        }
        if (event.type === 'operator_stall') stalls += 1;
        if (event.type === 'operator_escalation') escalations += 1;
        if (event.type === 'ai_error' || event.type === 'error') aiErrors += 1;
    }

    const significantTypes = new Set([
        'ai_plan',
        'operator_plan',
        'operator_stall',
        'operator_escalation',
        'trade_result',
        'trade_decision',
        'character_trace',
        'ai_error',
        'error',
    ]);
    const significant = events.filter(event => significantTypes.has(event.type));
    const recentActions = events
        .filter(event => event.type === 'operator_step' || event.type === 'skill_action')
        .slice(-200);
    const timeline = [...significant.slice(-500), ...recentActions]
        .sort((a, b) => a.ts - b.ts)
        .map(conciseEvent)
        .slice(-700);

    return {
        window: {
            startTs: events[0]?.ts ?? Date.now(),
            endTs: events.at(-1)?.ts ?? Date.now(),
            eventCount: events.length,
            hours,
        },
        current: {
            strategy: readJson('strategy.json'),
            operator: readJson('operator.json'),
            state: sanitizedPersistentState(),
            collection: readJson('collection.json'),
            guidance: readJson('human-guidance.json'),
            runtimeHealth: {
                mainLoop: readRuntimeHeartbeat('main-loop'),
                developmentReviewer: readRuntimeHeartbeat('development-reviewer'),
                maintenanceWorker: readRuntimeHeartbeat('maintenance-worker'),
            },
        },
        counts,
        outcomes: {
            successfulTrades,
            failedTrades,
            estimatedTradeProfitGp,
            successfulSteps,
            failedSteps,
            stalls,
            escalations,
            aiErrors,
        },
        repeatedFailures: [...failures.entries()]
            .map(([message, count]) => ({ message, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 20),
        timeline,
        systemicIssues: summarizeSystemicIssues(),
        registryMetrics: computeRegistryMetrics(),
    };
}
