// DayTrader - Bubblewrap Sandbox for the Pinned Verification Gate
//
// The pinned gate (pinnedGate.ts) still has to *execute* a patch's own
// (possibly agent-authored) source and test files with a real compiler and
// test runner - a fix cannot be verified without running it. This module is
// the trust boundary around that execution: every pinned gate step the
// deterministic host ever runs against untrusted patch content is wrapped
// in a bubblewrap (`bwrap`) sandbox with:
// - no network (`--unshare-net`, plus `--unshare-all` for every other
//   namespace bubblewrap supports);
// - no real `HOME` (a throwaway, empty tmpfs one instead - `--clearenv` plus
//   a fixed, minimal `--setenv` set);
// - no live-repository mount of anything beyond three explicit mounts: the
//   target worktree (read-write, at `/workspace` - the only thing a gate
//   step may ever mutate), a stable tool root's `node_modules` (read-only,
//   at `/workspace/node_modules`, so `tsc`/`bun` can resolve dependencies
//   even when the target worktree has none of its own), and the current
//   Bun executable (read-only, at `/bun`);
// - `/usr`, `/lib`, `/lib64`, `/proc`, `/dev`, and a tmpfs `/tmp` - the
//   minimum needed for a dynamically-linked `tsc`/`bun` binary to run at
//   all;
// - `--die-with-parent`, so nothing sandboxed ever outlives the host
//   process that spawned it.
//
// Fails closed: if the `bwrap` binary is not present at a fixed path, every
// sandboxed spawn call throws rather than ever falling back to running the
// pinned gate unsandboxed. Production code always uses
// `defaultSandboxSpawnFactory`; tests inject `identitySandboxSpawnFactory`
// (or a custom fake) via the same options plumbing already used for
// `spawn`/`agentRun`/`patchReview`, so no test needs a real `bwrap` except
// the one focused smoke test in bwrapSandbox.test.ts.

import { existsSync } from 'fs';
import { isAbsolute, relative, sep } from 'path';
import type { SpawnFn } from './isolatedWorkerRunner';

/** The only place bubblewrap is ever expected to live - verified present in this environment. Never resolved from `$PATH`. */
export const DEFAULT_BWRAP_PATH = '/usr/bin/bwrap';

export interface SandboxMounts {
    /** Real host path mounted read-write at `/workspace` - the only path a sandboxed command may ever mutate. */
    workspaceRealPath: string;
    /** Real host path of a stable tool root's own `node_modules`, mounted read-only at `/workspace/node_modules`. */
    toolNodeModulesRealPath: string;
    /** Real host path of the current Bun executable, mounted read-only at `/bun`. */
    bunExecutableRealPath: string;
}

function toPosix(path: string): string {
    return path.split(sep).join('/');
}

/**
 * Rewrites one argv token that refers to a real host path (or a path
 * nested under one) into its sandbox-visible equivalent; leaves every
 * other token (flags, non-path arguments) untouched. The `node_modules`
 * mount is checked before the broader workspace mount so a tool path
 * *inside* it (e.g. `toolRoot/node_modules/.bin/tsc`) resolves to
 * `/workspace/node_modules/.bin/tsc`, never some nonsensical path built
 * from the (unrelated) workspace mount.
 */
export function translateArgToSandbox(arg: string, mounts: SandboxMounts): string {
    if (arg === mounts.bunExecutableRealPath) return '/bun';
    const candidates: Array<[string, string]> = [
        [mounts.toolNodeModulesRealPath, '/workspace/node_modules'],
        [mounts.workspaceRealPath, '/workspace'],
    ];
    for (const [real, sandboxed] of candidates) {
        if (arg === real) return sandboxed;
        if (!isAbsolute(arg)) continue;
        const rel = relative(real, arg);
        if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
            return `${sandboxed}/${toPosix(rel)}`;
        }
    }
    return arg;
}

/** Translates every token of `argv` via {@link translateArgToSandbox}. Pure and independently testable without invoking bwrap. */
export function translateArgvForSandbox(argv: string[], mounts: SandboxMounts): string[] {
    return argv.map(arg => translateArgToSandbox(arg, mounts));
}

/**
 * Builds the fixed, pinned bubblewrap argv wrapping `innerArgv` (already
 * translated to sandbox-visible paths). This is a pure function - it never
 * touches the filesystem or spawns anything itself - so the exact,
 * reviewable sandbox flag set is unit-testable on its own.
 */
export function buildBwrapArgv(mounts: SandboxMounts, innerArgv: string[], bwrapPath: string = DEFAULT_BWRAP_PATH): string[] {
    return [
        bwrapPath,
        '--unshare-all',
        '--unshare-net',
        '--die-with-parent',
        '--ro-bind', '/usr', '/usr',
        '--symlink', 'usr/bin', '/bin',
        '--symlink', 'usr/lib', '/lib',
        '--symlink', 'usr/lib64', '/lib64',
        '--symlink', 'usr/sbin', '/sbin',
        '--proc', '/proc',
        '--dev', '/dev',
        '--tmpfs', '/tmp',
        '--bind', mounts.workspaceRealPath, '/workspace',
        '--ro-bind', mounts.toolNodeModulesRealPath, '/workspace/node_modules',
        '--ro-bind', mounts.bunExecutableRealPath, '/bun',
        '--clearenv',
        '--setenv', 'HOME', '/tmp',
        '--setenv', 'PATH', '/usr/bin:/bin',
        '--setenv', 'TMPDIR', '/tmp',
        '--chdir', '/workspace',
        '--',
        ...translateArgvForSandbox(innerArgv, mounts),
    ];
}

/** A `SpawnFn` factory: wraps a base spawn function so every call runs inside a sandbox, or (in tests) does not. */
export type SandboxSpawnFactory = (baseSpawn: SpawnFn, mounts: SandboxMounts) => SpawnFn;

export interface SandboxSpawnOptions {
    /** Overridable only for tests exercising the fail-closed path against a deliberately-missing binary. */
    bwrapPath?: string;
}

/**
 * Wraps `baseSpawn` so every call executes `argv` inside a fresh bubblewrap
 * sandbox built from `mounts` (see {@link buildBwrapArgv}). Fails closed: if
 * the bwrap binary is not present at `bwrapPath` (default
 * {@link DEFAULT_BWRAP_PATH}), every call rejects immediately rather than
 * ever falling back to running `argv` unsandboxed. Checked on every call
 * (not just once at construction), so a `bwrap` that is later removed is
 * never silently tolerated either.
 */
export function createSandboxedSpawnFn(baseSpawn: SpawnFn, mounts: SandboxMounts, options: SandboxSpawnOptions = {}): SpawnFn {
    const bwrapPath = options.bwrapPath ?? DEFAULT_BWRAP_PATH;
    return async (argv, opts) => {
        if (!existsSync(bwrapPath)) {
            return {
                argv,
                success: false,
                exitCode: null,
                stdout: '',
                stderr:
                    `Sandboxed execution requires bubblewrap at a fixed path ('${bwrapPath}'), but it was not found there. ` +
                    'Refusing to fall back to unsandboxed execution of untrusted patch content.',
            };
        }
        return baseSpawn(buildBwrapArgv(mounts, argv, bwrapPath), opts);
    };
}

/** The real, production factory: every pinned gate step actually runs inside a bubblewrap sandbox. */
export const defaultSandboxSpawnFactory: SandboxSpawnFactory = (baseSpawn, mounts) => createSandboxedSpawnFn(baseSpawn, mounts);

/**
 * Test-only factory: runs `argv` completely unsandboxed (the base spawn
 * function untouched). Never used in production - every production call
 * site defaults to {@link defaultSandboxSpawnFactory}; only a test
 * explicitly injects this instead, so ordinary worker/deployment tests
 * never need a real `bwrap` binary.
 */
export const identitySandboxSpawnFactory: SandboxSpawnFactory = baseSpawn => baseSpawn;
