import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import {
    captureStartupGeneration,
    getDeploymentReloadState,
    isReloadRequested,
    requestDeploymentReload,
} from '../lib/deploymentReload';

const DATA_DIR = join(import.meta.dir, '..', 'data');
let tempDir: string | null = null;

function pathFor(): string {
    tempDir = mkdtempSync(join(DATA_DIR, 'reload-'));
    return join(tempDir, 'deployment-reload.json');
}

afterEach(() => {
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = null;
    }
});

describe('deployment reload request store', () => {
    test('defaults to generation 0 when no file exists yet', () => {
        const path = pathFor();
        expect(getDeploymentReloadState(path).generation).toBe(0);
        expect(captureStartupGeneration(path)).toBe(0);
    });

    test('requesting a reload increments the generation and records the reason/revision', () => {
        const path = pathFor();
        const first = requestDeploymentReload('deployed issue-1', 'abc123', path);
        expect(first.generation).toBe(1);
        expect(first.reason).toBe('deployed issue-1');
        expect(first.deployedRevision).toBe('abc123');

        const second = requestDeploymentReload('rolled back issue-1', 'def456', path);
        expect(second.generation).toBe(2);
        expect(getDeploymentReloadState(path).generation).toBe(2);
    });

    test('a process that captured an older generation detects a newer request', () => {
        const path = pathFor();
        const startupGeneration = captureStartupGeneration(path);
        expect(isReloadRequested(startupGeneration, path)).toBe(false);

        requestDeploymentReload('deployed while running', 'commit-sha', path);
        expect(isReloadRequested(startupGeneration, path)).toBe(true);
    });

    test('a process that starts after the deploy never sees a stale reload request', () => {
        const path = pathFor();
        requestDeploymentReload('deployed before startup', 'commit-sha', path);
        const startupGeneration = captureStartupGeneration(path);
        expect(isReloadRequested(startupGeneration, path)).toBe(false);
    });

    test('a corrupt reload file is treated as generation 0 rather than throwing', () => {
        const path = pathFor();
        require('fs').writeFileSync(path, 'not json');
        expect(getDeploymentReloadState(path).generation).toBe(0);
    });
});
