import { describe, expect, test } from 'bun:test';
import { anyProtectedPathTouched, isProtectedPath, listProtectedPaths } from '../maintenance/protectedPaths';

describe('protectedPaths - control-plane and dependency-manifest policy', () => {
    test('protects package.json, lockfiles anywhere in the tree', () => {
        expect(isProtectedPath('package.json')).toBe(true);
        expect(isProtectedPath('server/webclient/package.json')).toBe(true);
        expect(isProtectedPath('bun.lock')).toBe(true);
        expect(isProtectedPath('bun.lockb')).toBe(true);
        expect(isProtectedPath('package-lock.json')).toBe(true);
        expect(isProtectedPath('yarn.lock')).toBe(true);
        expect(isProtectedPath('pnpm-lock.yaml')).toBe(true);
    });

    test('protects the entire autonomous maintenance control-plane directory, including any new file added there', () => {
        expect(isProtectedPath('bots/DayTrader/maintenance/autonomousWorkerRunner.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/maintenance/autonomousDeployment.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/maintenance/autonomousPermissionHandler.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/maintenance/autonomousRetryPolicy.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/maintenance/pinnedGate.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/maintenance/workerContract.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/maintenance/isolatedWorkerRunner.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/maintenance/runner.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/maintenance/protectedPaths.ts')).toBe(true);
        // A hypothetical brand-new file added to the directory later - never
        // requires remembering to update an exact-path allowlist.
        expect(isProtectedPath('bots/DayTrader/maintenance/someBrandNewControlPlaneFile.ts')).toBe(true);
    });

    test('protects the process supervisor', () => {
        expect(isProtectedPath('bots/DayTrader/run-supervisor.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/run-supervisor.sh')).toBe(true);
    });

    test('protects lib/ files whose name starts with "autonomous", covering future additions', () => {
        expect(isProtectedPath('bots/DayTrader/lib/autonomousAgentSchema.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/lib/autonomousDevelopmentAgent.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/lib/autonomousPatchReviewer.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/lib/autonomousPatchReviewSchema.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/lib/autonomousSomeFutureFile.ts')).toBe(true);
    });

    test('protects the specific non-"autonomous"-named lib/ files that are still load-bearing control-plane infrastructure', () => {
        expect(isProtectedPath('bots/DayTrader/lib/deploymentReload.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/lib/issueRegistry.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/lib/maintenanceStore.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/lib/registryDb.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/lib/developmentIssueBridge.ts')).toBe(true);
        expect(isProtectedPath('bots/DayTrader/lib/registryMetrics.ts')).toBe(true);
    });

    test('does not protect ordinary source/docs/test files', () => {
        expect(isProtectedPath('bots/DayTrader/lib/tradeEvaluator.ts')).toBe(false);
        expect(isProtectedPath('bots/DayTrader/test/tradeEvaluator.test.ts')).toBe(false);
        expect(isProtectedPath('sdk/index.ts')).toBe(false);
        expect(isProtectedPath('README.md')).toBe(false);
        expect(isProtectedPath('bots/DayTrader/daytrader.ts')).toBe(false);
    });

    test('anyProtectedPathTouched is true when any single path in a list is protected', () => {
        expect(anyProtectedPathTouched(['bots/DayTrader/lib/tradeEvaluator.ts', 'package.json'])).toBe(true);
        expect(anyProtectedPathTouched(['bots/DayTrader/lib/tradeEvaluator.ts', 'README.md'])).toBe(false);
        expect(anyProtectedPathTouched([])).toBe(false);
    });

    test('listProtectedPaths returns exactly the protected subset, preserving order', () => {
        expect(
            listProtectedPaths(['README.md', 'package.json', 'bots/DayTrader/lib/tradeEvaluator.ts', 'bots/DayTrader/maintenance/runner.ts'])
        ).toEqual(['package.json', 'bots/DayTrader/maintenance/runner.ts']);
    });

    test('normalizes backslashes and leading ./ before matching', () => {
        expect(isProtectedPath('.\\package.json'.replace('.\\', './'))).toBe(true);
        expect(isProtectedPath('bots\\DayTrader\\maintenance\\runner.ts')).toBe(true);
        expect(isProtectedPath('./package.json')).toBe(true);
    });
});
