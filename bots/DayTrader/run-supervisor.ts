#!/usr/bin/env bun
// DayTrader - Unified Health-Aware Supervisor
//
// Runs and restarts every DayTrader process from one place: the lite game
// client, the main strategist/operator loop, the development
// reviewer/worker, and the maintenance worker. Each child gets its own
// restart backoff (a child crash-looping immediately backs off
// exponentially up to a cap, instead of hammering the game server or the
// model APIs); a clean, longer-lived run resets that backoff. SIGINT/SIGTERM
// are forwarded to every child and the supervisor waits (bounded) for them
// to exit before exiting itself.
//
// The existing per-process scripts (run-lite-client.sh, run-main-loop.sh,
// run-development-agent.sh, run-observer.sh) are unchanged and still work
// standalone - this is an additional, opt-in way to run everything (minus
// the observer, which stays a manually-launched, single-run dashboard
// process by design) from a single supervised entrypoint.

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const WEBCLIENT_DIR = join(REPO_ROOT, 'server', 'webclient');
const BUN_EXECUTABLE = process.execPath;

interface ChildSpec {
    name: string;
    cmd: string[];
    cwd: string;
    /** Restart delay after a normal (long-lived) exit. */
    baseRestartDelayMs: number;
    /** Ceiling for exponential backoff after repeated fast crashes. */
    maxRestartDelayMs: number;
    /** A run shorter than this counts as a "fast failure" for backoff purposes. */
    fastFailureThresholdMs: number;
}

/** Pure: was this run short enough to count as a crash-loop failure? */
export function isFastFailure(ranMs: number, fastFailureThresholdMs: number): boolean {
    return ranMs < fastFailureThresholdMs;
}

/**
 * Pure: exponential backoff bounded by maxRestartDelayMs, keyed off how
 * many *consecutive* fast failures this child has had. A single slow/clean
 * exit resets the counter (see isFastFailure), so a child that runs fine
 * for a while and then crashes once is restarted promptly, not penalized
 * for a crash loop it isn't in.
 */
export function computeRestartDelayMs(spec: ChildSpec, consecutiveFastFailures: number): number {
    return Math.min(
        spec.baseRestartDelayMs * Math.pow(2, Math.max(0, consecutiveFastFailures - 1)),
        spec.maxRestartDelayMs
    );
}

const CHILDREN: ChildSpec[] = [
    {
        name: 'lite-client',
        cmd: [BUN_EXECUTABLE, 'src/lite/runner.ts', 'DayTrader'],
        cwd: WEBCLIENT_DIR,
        baseRestartDelayMs: 5_000,
        maxRestartDelayMs: 60_000,
        fastFailureThresholdMs: 10_000,
    },
    {
        name: 'main-loop',
        cmd: [BUN_EXECUTABLE, 'bots/DayTrader/daytrader.ts'],
        cwd: REPO_ROOT,
        baseRestartDelayMs: 5_000,
        maxRestartDelayMs: 60_000,
        fastFailureThresholdMs: 10_000,
    },
    {
        name: 'development-reviewer',
        cmd: [BUN_EXECUTABLE, 'bots/DayTrader/development/runner.ts'],
        cwd: REPO_ROOT,
        baseRestartDelayMs: 10_000,
        maxRestartDelayMs: 120_000,
        fastFailureThresholdMs: 15_000,
    },
    {
        name: 'maintenance-worker',
        cmd: [BUN_EXECUTABLE, 'bots/DayTrader/maintenance/runner.ts'],
        cwd: REPO_ROOT,
        baseRestartDelayMs: 15_000,
        maxRestartDelayMs: 120_000,
        fastFailureThresholdMs: 15_000,
    },
];

class SupervisedChild {
    private proc: ReturnType<typeof Bun.spawn> | null = null;
    private stopping = false;
    private consecutiveFastFailures = 0;

    constructor(private readonly spec: ChildSpec) {}

    async run(): Promise<void> {
        while (!this.stopping) {
            const startedAt = Date.now();
            console.log(`[supervisor] starting ${this.spec.name} at ${new Date(startedAt).toISOString()}`);
            this.proc = Bun.spawn({
                cmd: this.spec.cmd,
                cwd: this.spec.cwd,
                stdout: 'inherit',
                stderr: 'inherit',
                stdin: 'inherit',
            });
            const exitCode = await this.proc.exited;
            this.proc = null;
            if (this.stopping) break;

            const ranMs = Date.now() - startedAt;
            const wasFastFailure = isFastFailure(ranMs, this.spec.fastFailureThresholdMs);
            this.consecutiveFastFailures = wasFastFailure ? this.consecutiveFastFailures + 1 : 0;
            const delay = computeRestartDelayMs(this.spec, this.consecutiveFastFailures);
            console.log(
                `[supervisor] ${this.spec.name} exited (code ${exitCode}) after ${ranMs}ms` +
                    (wasFastFailure ? ` [fast failure #${this.consecutiveFastFailures}]` : '') +
                    `, restarting in ${delay}ms`
            );
            await Bun.sleep(delay);
        }
        console.log(`[supervisor] ${this.spec.name} stopped`);
    }

    stop(signal: NodeJS.Signals): void {
        this.stopping = true;
        this.proc?.kill(signal);
    }

    isRunning(): boolean {
        return this.proc !== null;
    }

    get name(): string {
        return this.spec.name;
    }
}

function main(): void {
    const children = CHILDREN.map(spec => new SupervisedChild(spec));
    let shuttingDown = false;

    function shutdown(signal: NodeJS.Signals): void {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[supervisor] received ${signal}, stopping all children`);
        for (const child of children) child.stop(signal);
        // Bounded cleanup window, then force-exit even if a child is slow
        // to release its own resources (SDK sockets, git subprocesses).
        setTimeout(() => {
            console.log('[supervisor] cleanup window elapsed, exiting');
            process.exit(0);
        }, 8_000).unref();
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    console.log(
        `[supervisor] starting ${children.length} DayTrader processes: ${children.map(child => child.name).join(', ')}`
    );
    void Promise.all(children.map(child => child.run()));
}

// Guarded so this module can be imported (e.g. by tests exercising the
// pure backoff helpers above) without spawning any real child processes.
if (import.meta.main) {
    main();
}
