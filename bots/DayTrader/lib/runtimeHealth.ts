import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

export interface RuntimeHeartbeat {
    process: string;
    pid: number;
    phase: string;
    at: number;
}

function heartbeatPath(processName: string): string {
    return join(DATA_DIR, `${processName}.heartbeat.json`);
}

export function recordRuntimeHeartbeat(processName: string, phase: string, now = Date.now()): void {
    mkdirSync(DATA_DIR, { recursive: true });
    const path = heartbeatPath(processName);
    const temp = `${path}.${process.pid}.tmp`;
    const heartbeat: RuntimeHeartbeat = {
        process: processName,
        pid: process.pid,
        phase,
        at: now,
    };
    writeFileSync(temp, JSON.stringify(heartbeat));
    renameSync(temp, path);
}

export function readRuntimeHeartbeat(processName: string): RuntimeHeartbeat | null {
    const path = heartbeatPath(processName);
    if (!existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimeHeartbeat>;
    if (
        value.process !== processName ||
        typeof value.pid !== 'number' ||
        typeof value.phase !== 'string' ||
        typeof value.at !== 'number'
    ) {
        throw new Error(`Invalid runtime heartbeat '${path}'`);
    }
    return value as RuntimeHeartbeat;
}

export function isHeartbeatStale(
    heartbeatAt: number | null,
    now: number,
    maxAgeMs: number
): boolean {
    return heartbeatAt === null || now - heartbeatAt > maxAgeMs;
}
