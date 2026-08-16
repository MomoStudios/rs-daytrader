// DayTrader - Decision Logger
//
// Append-only JSONL log of every notable decision (chat classified, trade
// evaluated, ad sent, scam flagged) so a human (or a future agent session)
// can audit *why* the bot did what it did without re-deriving it, and so
// ambiguous cases can be reviewed later without needing the LLM in the loop
// for routine operation.

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let dataDir = join(__dirname, '..', 'data');

function logPath(): string {
    return join(dataDir, 'decisions.jsonl');
}

/**
 * Test-only hook: redirect the append-only log to an isolated directory so
 * tests exercising code that calls log() never write into the real
 * runtime data folder. Never called from production code paths.
 */
export function _setLogDataDirForTests(dir: string): void {
    dataDir = dir;
}

export type LogEventType =
    | 'chat_classified'
    | 'scam_flagged'
    | 'trade_opportunity_seen'
    | 'trade_decision'
    | 'trade_result'
    | 'ad_sent'
    | 'idle_economy'
    | 'ai_plan'
    | 'ai_error'
    | 'skill_action'
    | 'operator_plan'
    | 'operator_step'
    | 'operator_stall'
    | 'operator_escalation'
    | 'operator_escalation_timeout'
    | 'operator_escalation_acknowledged'
    | 'operator_issue'
    | 'operator_remediation'
    | 'operator_remediation_applied'
    | 'development_review'
    | 'development_error'
    | 'development_issue'
    | 'workflow_candidate'
    | 'maintenance_work'
    | 'character_trace'
    | 'goal_completed'
    | 'error'
    | 'note';

export interface LogEvent {
    ts: number;
    type: LogEventType;
    [key: string]: unknown;
}

function ensureDataDir(): void {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
}

export function log(type: LogEventType, data: Record<string, unknown> = {}): void {
    ensureDataDir();
    const event: LogEvent = { ts: Date.now(), type, ...data };
    try {
        appendFileSync(logPath(), JSON.stringify(event) + '\n');
    } catch (e) {
        console.warn(`[logger] Failed to append log: ${e}`);
    }
    // Mirror to console so a foreground/log-tailed run is human-readable too.
    const { ts: _t, type: _ty, ...rest } = event;
    console.log(`[${new Date(event.ts).toISOString()}] ${type}`, rest);
}
