// DayTrader - Deployment Reload Request Store
//
// The autonomous development pipeline deploys code changes into the live
// checkout by cherry-picking (or reverting) commits while every DayTrader
// process keeps running against its already-imported module graph. A
// process that never reloads would keep running stale code indefinitely,
// silently undoing the point of automated repair.
//
// This is a tiny, file-backed generation counter: every successful deploy
// or verified rollback bumps `generation`. Every long-running process
// (main loop, development reviewer, maintenance worker) captures its own
// `generation` at startup and periodically checks whether a *newer*
// generation has been requested. When it has, the process finishes any
// in-flight lifecycle persistence and exits cleanly (status 0) so the
// existing supervisor (run-supervisor.ts) restarts it - picking up the
// freshly deployed code the same way a crash-restart would, but
// deliberately rather than by accident.
//
// This module never restarts anything itself: it only records/reads the
// request. Actually exiting is each process's own responsibility, at a
// point where it has nothing left to lose (see the reload checks in
// daytrader.ts, development/runner.ts, and maintenance/runner.ts).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const RELOAD_PATH = join(DATA_DIR, 'deployment-reload.json');

export interface DeploymentReloadState {
    generation: number;
    requestedAt: number;
    reason: string;
    deployedRevision: string | null;
}

function defaults(): DeploymentReloadState {
    return { generation: 0, requestedAt: 0, reason: '', deployedRevision: null };
}

function load(path: string): DeploymentReloadState {
    if (!existsSync(path)) return defaults();
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DeploymentReloadState>;
        if (typeof parsed.generation !== 'number') return defaults();
        return {
            generation: parsed.generation,
            requestedAt: typeof parsed.requestedAt === 'number' ? parsed.requestedAt : 0,
            reason: typeof parsed.reason === 'string' ? parsed.reason : '',
            deployedRevision: typeof parsed.deployedRevision === 'string' ? parsed.deployedRevision : null,
        };
    } catch (error) {
        console.warn(`[deploymentReload] Could not read reload state '${path}': ${error}`);
        return defaults();
    }
}

function save(path: string, value: DeploymentReloadState): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2));
    renameSync(temp, path);
}

export function getDeploymentReloadState(path: string = RELOAD_PATH): DeploymentReloadState {
    return load(path);
}

/**
 * Records a new deployment/rollback generation. Called by the deploy and
 * rollback paths of the autonomous maintenance pipeline right after a
 * commit lands (or is reverted) in the live checkout.
 */
export function requestDeploymentReload(
    reason: string,
    deployedRevision: string | null = null,
    path: string = RELOAD_PATH
): DeploymentReloadState {
    const current = load(path);
    const next: DeploymentReloadState = {
        generation: current.generation + 1,
        requestedAt: Date.now(),
        reason,
        deployedRevision,
    };
    save(path, next);
    return next;
}

/** Captured once at process startup, before the first reload check. */
export function captureStartupGeneration(path: string = RELOAD_PATH): number {
    return load(path).generation;
}

/** True once a deploy/rollback has happened after this process started. */
export function isReloadRequested(startupGeneration: number, path: string = RELOAD_PATH): boolean {
    return load(path).generation > startupGeneration;
}
