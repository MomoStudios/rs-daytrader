import { describe, expect, test } from 'bun:test';

type WorkerTimerModule = typeof import('./WorkerTimer.js');

/**
 * Load a fresh copy of the module. It memoises whether a worker is available,
 * so each scenario needs its own instance.
 */
let variant = 0;
async function freshModule(): Promise<WorkerTimerModule> {
    return import(`./WorkerTimer.js?variant=${variant++}`) as Promise<WorkerTimerModule>;
}

/** A worker that echoes each id back after its delay, like the real one. */
class EchoWorker {
    onmessage: ((event: { data: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    posted: { id: number; ms: number }[] = [];

    postMessage(data: { id: number; ms: number }): void {
        this.posted.push(data);
        setTimeout(() => this.onmessage?.({ data: data.id }), data.ms);
    }

    terminate(): void {}
}

/** Install stubs for the globals the module builds a worker from. */
function withWorkerGlobals(factory: () => unknown): () => void {
    const saved = {
        Worker: (globalThis as Record<string, unknown>).Worker,
        Blob: (globalThis as Record<string, unknown>).Blob,
        URL: (globalThis as Record<string, unknown>).URL
    };
    const realUrl = globalThis.URL;

    (globalThis as Record<string, unknown>).Worker = factory;
    (globalThis as Record<string, unknown>).Blob = class {};
    (globalThis as Record<string, unknown>).URL = Object.assign(
        function URLStub() {} as unknown as typeof realUrl,
        { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} }
    );

    return () => {
        (globalThis as Record<string, unknown>).Worker = saved.Worker;
        (globalThis as Record<string, unknown>).Blob = saved.Blob;
        (globalThis as Record<string, unknown>).URL = saved.URL;
    };
}

describe('WorkerTimer', () => {
    test('falls back to setTimeout when workers are unavailable', async () => {
        const saved = (globalThis as Record<string, unknown>).Worker;
        delete (globalThis as Record<string, unknown>).Worker;

        try {
            const { delay, isWorkerTimerActive } = await freshModule();

            expect(isWorkerTimerActive()).toBe(false);

            const start = performance.now();
            await delay(20);
            expect(performance.now() - start).toBeGreaterThanOrEqual(15);
        } finally {
            (globalThis as Record<string, unknown>).Worker = saved;
        }
    });

    test('runs on a real worker when the platform provides one', async () => {
        const { delay, isWorkerTimerActive } = await freshModule();

        expect(isWorkerTimerActive()).toBe(true);

        const start = performance.now();
        await delay(20);
        expect(performance.now() - start).toBeGreaterThanOrEqual(15);
    });

    test('drives delays through the worker when one can be created', async () => {
        let created: EchoWorker | null = null;
        const restore = withWorkerGlobals(function (this: unknown) {
            created = new EchoWorker();
            return created;
        });

        try {
            const { delay, isWorkerTimerActive } = await freshModule();

            expect(isWorkerTimerActive()).toBe(true);
            await delay(5);
            await delay(7);

            expect(created!.posted.map(p => p.ms)).toEqual([5, 7]);
            // Ids must be distinct, or one reply would resolve the wrong waiter.
            expect(new Set(created!.posted.map(p => p.id)).size).toBe(2);
        } finally {
            restore();
        }
    });

    test('releases waiters and stops using a worker that errors', async () => {
        let created: EchoWorker | null = null;
        const restore = withWorkerGlobals(function (this: unknown) {
            created = new EchoWorker();
            return created;
        });

        try {
            const { delay, isWorkerTimerActive } = await freshModule();

            // A delay long enough that only the error can resolve it in time.
            const waiting = delay(60_000);
            created!.onerror?.();

            await waiting; // hangs forever if the error path drops its waiters
            expect(isWorkerTimerActive()).toBe(false);

            // Later calls still work, now on setTimeout.
            await delay(1);
        } finally {
            restore();
        }
    });
});
