import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let dataDir = join(__dirname, '..', 'data');

/**
 * Test-only hook: redirect heartbeat reads/writes to an isolated directory
 * (e.g. a scratch git repo fixture) so tests never touch the real runtime
 * data folder or read a stale heartbeat left by a previous test. Never
 * called from production code paths.
 */
export function _setRuntimeHealthDataDirForTests(dir: string): void {
    dataDir = dir;
}

export interface RuntimeHeartbeat {
    process: string;
    pid: number;
    phase: string;
    at: number;
    /**
     * The deployment-reload generation (see lib/deploymentReload.ts) this
     * process captured at its own startup, carried on every single
     * heartbeat it ever writes. This is what lets a canary promotion
     * decision (see autonomousDeployment.ts's evaluateCanary) tell a truly
     * *new*, freshly-restarted process (whose captured generation is at
     * least the one required by the deploy that is being evaluated) apart
     * from the same old process merely continuing to beat (whose captured
     * generation is fixed at whatever it was when it started and can never
     * advance without an actual restart) - a distinction a bare
     * "heartbeat happened after deployedAt" timestamp check cannot make,
     * since the old process keeps writing heartbeats for a while after
     * a deploy/reload request until it next checks isReloadRequested()
     * between loop iterations and exits.
     */
    deploymentGeneration: number;
}

function heartbeatPath(processName: string): string {
    return join(dataDir, `${processName}.heartbeat.json`);
}

export function recordRuntimeHeartbeat(
    processName: string,
    phase: string,
    deploymentGeneration: number,
    now = Date.now()
): void {
    mkdirSync(dataDir, { recursive: true });
    const path = heartbeatPath(processName);
    const temp = `${path}.${process.pid}.tmp`;
    const heartbeat: RuntimeHeartbeat = {
        process: processName,
        pid: process.pid,
        phase,
        at: now,
        deploymentGeneration,
    };
    writeFileSync(temp, JSON.stringify(heartbeat));
    renameSync(temp, path);
}

/**
 * Parses a heartbeat file, tolerating one specific backward-compatible
 * migration: a heartbeat written before `deploymentGeneration` existed
 * (e.g. left over from a process still running an older version at the
 * moment this migration itself deploys) never crashes this parse. It is
 * defaulted to `-1` - a value no real captured startup generation can ever
 * equal (`captureStartupGeneration` always returns a value `>= 0`) - so a
 * canary promotion check that requires `deploymentGeneration >=
 * requiredReloadGeneration` can never be satisfied by a legacy heartbeat
 * missing the field, never a false promotion. Every other field remains
 * strictly required, exactly as before.
 */
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
    return {
        process: value.process,
        pid: value.pid,
        phase: value.phase,
        at: value.at,
        deploymentGeneration: typeof value.deploymentGeneration === 'number' ? value.deploymentGeneration : -1,
    };
}

export function isHeartbeatStale(
    heartbeatAt: number | null,
    now: number,
    maxAgeMs: number
): boolean {
    return heartbeatAt === null || now - heartbeatAt > maxAgeMs;
}
