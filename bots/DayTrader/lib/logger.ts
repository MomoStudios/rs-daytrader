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
const DATA_DIR = join(__dirname, '..', 'data');
const LOG_PATH = join(DATA_DIR, 'decisions.jsonl');

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
    | 'error'
    | 'note';

export interface LogEvent {
    ts: number;
    type: LogEventType;
    [key: string]: unknown;
}

function ensureDataDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function log(type: LogEventType, data: Record<string, unknown> = {}): void {
    ensureDataDir();
    const event: LogEvent = { ts: Date.now(), type, ...data };
    try {
        appendFileSync(LOG_PATH, JSON.stringify(event) + '\n');
    } catch (e) {
        console.warn(`[logger] Failed to append log: ${e}`);
    }
    // Mirror to console so a foreground/log-tailed run is human-readable too.
    const { ts: _t, type: _ty, ...rest } = event;
    console.log(`[${new Date(event.ts).toISOString()}] ${type}`, rest);
}
