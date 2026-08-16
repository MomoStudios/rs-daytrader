import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
    DEFAULT_BWRAP_PATH,
    buildBwrapArgv,
    createSandboxedSpawnFn,
    identitySandboxSpawnFactory,
    translateArgToSandbox,
    translateArgvForSandbox,
    type SandboxMounts,
} from '../maintenance/bwrapSandbox';
import { defaultSpawn } from '../maintenance/isolatedWorkerRunner';

const DATA_DIR = join(import.meta.dir, '..', 'data');

function mounts(overrides: Partial<SandboxMounts> = {}): SandboxMounts {
    return {
        workspaceRealPath: '/repo/worktree',
        toolNodeModulesRealPath: '/repo/node_modules',
        bunExecutableRealPath: '/home/user/.bun/bin/bun',
        ...overrides,
    };
}

describe('bwrapSandbox - translateArgToSandbox / translateArgvForSandbox', () => {
    test('rewrites the bun executable to /bun', () => {
        expect(translateArgToSandbox('/home/user/.bun/bin/bun', mounts())).toBe('/bun');
    });

    test('rewrites a toolRoot node_modules path (and anything nested under it) to /workspace/node_modules/...', () => {
        expect(translateArgToSandbox('/repo/node_modules', mounts())).toBe('/workspace/node_modules');
        expect(translateArgToSandbox('/repo/node_modules/.bin/tsc', mounts())).toBe('/workspace/node_modules/.bin/tsc');
    });

    test('rewrites the workspace root (and anything nested under it) to /workspace/...', () => {
        expect(translateArgToSandbox('/repo/worktree', mounts())).toBe('/workspace');
        expect(translateArgToSandbox('/repo/worktree/server/webclient/tsconfig.json', mounts())).toBe('/workspace/server/webclient/tsconfig.json');
    });

    test('checks node_modules before the broader workspace mount, since node_modules is nested under a different real root than the worktree in the worker scenario', () => {
        const m = mounts({ workspaceRealPath: '/repo/.worktrees/work-1', toolNodeModulesRealPath: '/repo/node_modules' });
        expect(translateArgToSandbox('/repo/node_modules/.bin/tsc', m)).toBe('/workspace/node_modules/.bin/tsc');
        expect(translateArgToSandbox('/repo/.worktrees/work-1/lib/thing.ts', m)).toBe('/workspace/lib/thing.ts');
    });

    test('leaves flags, relative paths, and unrelated absolute paths untouched', () => {
        expect(translateArgToSandbox('--noEmit', mounts())).toBe('--noEmit');
        expect(translateArgToSandbox('-p', mounts())).toBe('-p');
        expect(translateArgToSandbox('sdk/test', mounts())).toBe('sdk/test');
        expect(translateArgToSandbox('/etc/passwd', mounts())).toBe('/etc/passwd');
    });

    test('translateArgvForSandbox maps every token independently, matching a real pinned gate step', () => {
        const argv = ['/repo/node_modules/.bin/tsc', '--noEmit', '-p', '/repo/worktree/bots/DayTrader/tsconfig.json'];
        expect(translateArgvForSandbox(argv, mounts())).toEqual([
            '/workspace/node_modules/.bin/tsc',
            '--noEmit',
            '-p',
            '/workspace/bots/DayTrader/tsconfig.json',
        ]);
        const testArgv = ['/home/user/.bun/bin/bun', 'test', 'sdk/test', 'bots/DayTrader/test'];
        expect(translateArgvForSandbox(testArgv, mounts())).toEqual(['/bun', 'test', 'sdk/test', 'bots/DayTrader/test']);
    });
});

describe('bwrapSandbox - buildBwrapArgv', () => {
    test('builds a fixed, reviewable flag sequence: no network, no real HOME, exactly the three mounts, dies with parent', () => {
        const argv = buildBwrapArgv(mounts(), ['/bun', 'test'], '/usr/bin/bwrap');
        expect(argv[0]).toBe('/usr/bin/bwrap');
        expect(argv).toContain('--unshare-net');
        expect(argv).toContain('--unshare-all');
        expect(argv).toContain('--die-with-parent');
        expect(argv).toContain('--clearenv');
        // HOME is always the throwaway tmpfs one, never a real directory.
        const homeIndex = argv.indexOf('HOME');
        expect(argv[homeIndex + 1]).toBe('/tmp');
        // Exactly the three mounts this module ever grants.
        expect(argv.join(' ')).toContain('--bind /repo/worktree /workspace');
        expect(argv.join(' ')).toContain('--ro-bind /repo/node_modules /workspace/node_modules');
        expect(argv.join(' ')).toContain('--ro-bind /home/user/.bun/bin/bun /bun');
        // No live repository root mount, no real HOME bind of any kind.
        expect(argv).not.toContain('/home/user');
        expect(argv.some(token => token.includes('.gitconfig'))).toBe(false);
        // The translated inner command comes after the `--` separator.
        expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['/bun', 'test']);
    });

    test('uses the given bwrapPath rather than any $PATH resolution', () => {
        const argv = buildBwrapArgv(mounts(), ['/bun', '--version'], '/custom/path/to/bwrap');
        expect(argv[0]).toBe('/custom/path/to/bwrap');
    });
});

describe('bwrapSandbox - createSandboxedSpawnFn fails closed', () => {
    test('rejects (never falls back unsandboxed) when the bwrap binary does not exist at the given path', async () => {
        let baseSpawnCalled = false;
        const baseSpawn = async (argv: string[]) => {
            baseSpawnCalled = true;
            return { argv, success: true, exitCode: 0, stdout: 'should never run', stderr: '' };
        };
        const sandboxed = createSandboxedSpawnFn(baseSpawn, mounts(), { bwrapPath: '/definitely/not/a/real/bwrap/binary' });
        const result = await sandboxed(['/bun', '--version'], { cwd: '/tmp', env: {}, timeoutMs: 5000 });
        expect(result.success).toBe(false);
        expect(result.stderr).toContain('bubblewrap');
        expect(baseSpawnCalled).toBe(false); // never fell back to running it unsandboxed
    });

    test('DEFAULT_BWRAP_PATH is the fixed, expected production path', () => {
        expect(DEFAULT_BWRAP_PATH).toBe('/usr/bin/bwrap');
    });
});

describe('bwrapSandbox - identitySandboxSpawnFactory (test-only bypass)', () => {
    test('returns the base spawn function completely untouched - no bwrap involved at all', async () => {
        const baseSpawn = async (argv: string[]) => ({ argv, success: true, exitCode: 0, stdout: 'ran unsandboxed', stderr: '' });
        const wrapped = identitySandboxSpawnFactory(baseSpawn, mounts());
        expect(wrapped).toBe(baseSpawn);
        const result = await wrapped(['echo', 'hi'], { cwd: '/tmp', env: {}, timeoutMs: 1000 });
        expect(result.stdout).toBe('ran unsandboxed');
    });
});

describe('bwrapSandbox - real bwrap smoke test (the one place a real sandbox actually runs)', () => {
    test('actually sandboxes a real command: workspace is writable, node_modules is read-only, and there is no network', async () => {
        const scratch = mkdtempSync(join(DATA_DIR, 'bwrap-smoke-'));
        try {
            const workspace = join(scratch, 'workspace');
            const nodeModules = join(scratch, 'node_modules');
            mkdirSync(workspace, { recursive: true });
            mkdirSync(nodeModules, { recursive: true });
            writeFileSync(join(nodeModules, 'marker.txt'), 'read-only-marker');

            const sandboxed = createSandboxedSpawnFn(defaultSpawn, {
                workspaceRealPath: workspace,
                toolNodeModulesRealPath: nodeModules,
                bunExecutableRealPath: process.execPath,
            });

            // 1. The sandboxed process can see and write inside /workspace.
            const writeResult = await sandboxed(
                ['/bun', '-e', "require('fs').writeFileSync('/workspace/from-sandbox.txt', 'hello'); console.log('wrote ok')"],
                { cwd: scratch, env: {}, timeoutMs: 15_000 }
            );
            expect(writeResult.success).toBe(true);
            expect(writeResult.stdout).toContain('wrote ok');
            expect(readFileSync(join(workspace, 'from-sandbox.txt'), 'utf8')).toBe('hello');

            // 2. node_modules is mounted read-only - a write attempt fails from inside the sandbox.
            const roResult = await sandboxed(
                [
                    '/bun',
                    '-e',
                    "try { require('fs').writeFileSync('/workspace/node_modules/evil.txt', 'x'); console.log('WROTE'); } catch (e) { console.log('BLOCKED:' + e.message); }",
                ],
                { cwd: scratch, env: {}, timeoutMs: 15_000 }
            );
            expect(roResult.success).toBe(true);
            expect(roResult.stdout).toContain('BLOCKED');
            expect(existsSync(join(nodeModules, 'evil.txt'))).toBe(false);

            // 3. No network access at all.
            const netResult = await sandboxed(
                [
                    '/bun',
                    '-e',
                    "fetch('http://169.254.169.254/').then(() => console.log('NETWORK OK')).catch((e) => console.log('NETWORK BLOCKED:' + e.message))",
                ],
                { cwd: scratch, env: {}, timeoutMs: 15_000 }
            );
            expect(netResult.success).toBe(true);
            expect(netResult.stdout).toContain('NETWORK BLOCKED');
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    }, 30_000);
});
