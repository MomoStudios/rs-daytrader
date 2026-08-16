// DayTrader - Autonomous Development Agent Permission Handler
//
// Deny-by-default gate for every permission request the autonomous coding
// agent's session can raise. Nothing is approved unless it matches an
// explicit rule below - the deterministic host, not the model, decides what
// the agent may read, write, or run. Reads/writes are confined to the
// agent's own isolated git worktree and may never touch `.git`,
// `node_modules`, credentials, private keys, or any DayTrader runtime data
// store. Shell commands are limited to a small allowlist of local,
// read-only/inspection/test commands; nothing that pushes, mutates git
// history, installs dependencies, reaches the network, or could smuggle a
// denied command through substitution/redirection is ever approved. Every
// other permission kind (MCP, URL, memory, custom tool, hook, extension
// management, factory, extension permission access) is unconditionally
// denied - the agent is never given those tools in the first place (see
// autonomousDevelopmentAgent.ts), but this handler denies them anyway in
// case the runtime ever raises one.
//
// The deterministic host (maintenance/autonomousWorkerRunner.ts) - never the
// agent - owns git commit/push/deploy. This handler cannot be bypassed by
// the model asking nicely: every branch is a pure function of the request,
// fully unit-testable without a real Copilot session.

import { existsSync, realpathSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import type { PermissionHandler, PermissionRequest } from '@github/copilot-sdk';

export interface PolicyDecision {
    allowed: boolean;
    reason: string;
}

// ---------------------------------------------------------------------------
// Path canonicalization and worktree confinement
// ---------------------------------------------------------------------------

/**
 * Resolves `path` to its canonical real filesystem form. Walks up to the
 * nearest existing ancestor when the path (or a new file about to be
 * written) doesn't exist yet, realpath-resolves that ancestor (following any
 * symlinks), and reattaches the not-yet-existing tail literally. This
 * prevents a symlinked ancestor directory from being used to smuggle a
 * write outside the sandbox root, and correctly handles brand-new files the
 * agent is about to create.
 */
export function canonicalize(path: string): string {
    let target = resolve(path);
    const tail: string[] = [];
    // The filesystem root always exists, so this loop is bounded.
    while (!existsSync(target)) {
        tail.unshift(basename(target));
        const parent = dirname(target);
        if (parent === target) break;
        target = parent;
    }
    const real = realpathSync(target);
    return tail.length > 0 ? join(real, ...tail) : real;
}

const BLOCKED_PATH_PATTERNS: RegExp[] = [
    /(^|\/)\.git(\/|$)/,
    /(^|\/)node_modules(\/|$)/,
    /(^|\/)bot\.env$/,
    /(^|\/)\.env(\.[^/]*)?$/,
    // The runtime data directory (registry.sqlite, decisions.jsonl,
    // strategy/operator/development JSON state, heartbeats, ...) is
    // deliberately outside every isolated worktree's checkout, but this is
    // also enforced defense-in-depth in case a future worktree layout
    // changes.
    /(^|\/)bots\/DayTrader\/data(\/|$)/,
    /credentials?(\/|\.|$)/i,
    /\.pem$/i,
    /id_(rsa|dsa|ecdsa|ed25519)(\.[^/]*)?$/i,
    /private[-_]?key/i,
    /(^|\/)\.ssh(\/|$)/,
    /(^|\/)\.aws(\/|$)/,
];

function toPosix(path: string): string {
    return path.split(sep).join('/');
}

/**
 * Approves a read/write path only when it canonicalizes to somewhere inside
 * the isolated worktree root and does not match any blocked pattern.
 * Symlink/`..` traversal tricks are neutralized by canonicalizing both sides
 * before comparing.
 */
export function evaluatePathAccess(worktreeRoot: string, requestedPath: string): PolicyDecision {
    if (!requestedPath || !requestedPath.trim()) {
        return { allowed: false, reason: 'empty path; deny by default' };
    }
    let canonicalRoot: string;
    let canonicalTarget: string;
    try {
        canonicalRoot = canonicalize(worktreeRoot);
        const workspaceRelative =
            requestedPath === '/workspace'
                ? ''
                : requestedPath.startsWith('/workspace/')
                  ? requestedPath.slice('/workspace/'.length)
                  : null;
        canonicalTarget = canonicalize(
            workspaceRelative === null ? requestedPath : join(worktreeRoot, workspaceRelative)
        );
    } catch (error) {
        return { allowed: false, reason: `cannot canonicalize path (deny by default): ${error}` };
    }
    const rel = relative(canonicalRoot, canonicalTarget);
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
        return { allowed: false, reason: `path escapes the isolated worktree: ${requestedPath}` };
    }
    const relativePosix = toPosix(rel);
    const fullPosix = toPosix(canonicalTarget);
    for (const pattern of BLOCKED_PATH_PATTERNS) {
        if (pattern.test(relativePosix) || pattern.test(fullPosix)) {
            return { allowed: false, reason: `path matches a blocked pattern (${pattern}): ${requestedPath}` };
        }
    }
    return { allowed: true, reason: 'path is within the isolated worktree and matches no blocked pattern' };
}

// ---------------------------------------------------------------------------
// Shell command policy
// ---------------------------------------------------------------------------

/**
 * Identifiers allowed unconditionally: genuinely stateless, read-only local
 * inspection utilities only. Nothing here can execute code, mutate files,
 * install dependencies, or reach the network.
 *
 * `awk`, `sed`, and `find` are deliberately excluded - each has argv-level
 * primitives that execute arbitrary code or mutate files in place (awk's
 * `system()`/`ENVIRON`, sed's `-i`/`e`/`w` commands, find's
 * `-exec`/`-execdir`/`-ok`/`-okdir`/`-delete`/`-fprintf`), and no argv-safe
 * mode for any of them is implemented here.
 *
 * `sort` is excluded for the same reason: its `-o`/`--output` flag writes
 * its result to an arbitrary file, `-o` and its value are not reliably
 * distinguishable from a harmless bundled short flag using only this
 * module's generic "bare flag" check, and GNU/BSD short-option bundling
 * (`-ro FILE`, etc.) makes a narrow, provably-safe argv check impractical
 * here - the same reasoning that excludes awk/sed/find.
 *
 * `bun` and `tsc` are deliberately excluded too, and permanently: both are
 * interpreters/build tools capable of executing arbitrary project code
 * (`bun run`/`bun test` execute JS/TS - including any test file or
 * `tsconfig.json` `plugins`/loader the agent's own patch just wrote - and
 * `tsc` loads and executes `tsconfig.json`, including its `plugins` field).
 * The autonomous agent must never be able to run its own tests, type
 * checks, or any other interpreter/build step - only the deterministic
 * host (via the pinned, sandboxed verification gate - see pinnedGate.ts and
 * bwrapSandbox.ts) ever executes those. If a narrow safe mode for any
 * excluded command is ever justified, it must be added as its own
 * reviewed, explicitly-tested predicate - never by re-adding the bare
 * identifier.
 */
const ALLOWED_BARE_IDENTIFIERS = new Set([
    'rg',
    'grep',
    'head',
    'tail',
    'cat',
    'ls',
    'pwd',
    'wc',
    'uniq',
    'diff',
    'test',
]);

/**
 * Of {@link ALLOWED_BARE_IDENTIFIERS}, the subset whose non-flag argv
 * tokens are always file/directory path operands - independently
 * (self-)validated against the worktree on EVERY call, not merely as a
 * fallback for when the runtime supplies no `possiblePaths` extraction: an
 * empty (or otherwise incomplete) `possiblePaths` array is never, by
 * itself, sufficient corroboration that a command's own arguments are
 * safe, since this module has no way to distinguish "there truly are no
 * paths" from "the runtime's extractor under-reported them." `grep`/`rg`
 * are deliberately excluded from this set: their first non-flag token is a
 * search pattern, not a path, and a `-f <patternfile>`/`-e <pattern>` style
 * flag makes reliably telling patterns and paths apart from argv alone too
 * ambiguous to trust - those two commands fail closed instead whenever
 * `possiblePaths` is unavailable, and are otherwise trusted only via the
 * runtime's own extraction. `pwd` takes no path operands at all.
 */
const SELF_PARSEABLE_PATH_COMMANDS = new Set(['cat', 'head', 'tail', 'ls', 'wc', 'uniq', 'diff', 'test']);

const ALLOWED_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse']);
const DENIED_GIT_SUBCOMMANDS = new Set([
    'push',
    'fetch',
    'pull',
    'reset',
    'clean',
    'checkout',
    'switch',
    'rebase',
    'merge',
    'cherry-pick',
    'commit',
]);

/** Command substitution, backticks, or an explicit `eval` invocation. */
const DANGEROUS_TEXT_PATTERN = /\$\(|`|(^|[\s;&|])eval(\s|$)/i;

/**
 * Shell control/chaining operators: `;`, `&&`, `||`, a pipe, backgrounding
 * `&`, or a literal newline. Any of these mean the text is not a single
 * command, so it may only be approved when the runtime has actually parsed
 * it into that many independently-vetted `commandSegments` - never trusted
 * to a single fallback segment covering the whole string.
 */
const CONTROL_OPERATOR_PATTERN = /(&&|\|\||;|\||&|\n|\r)/;

/**
 * A plain repo-relative argument token with no leading dash, no absolute
 * path, no `..` traversal, no `~`/`$` expansion, and no shell
 * metacharacters. Reused both for {@link evaluateShellRequest}'s
 * possible-path validation and for the self-parse fallback below.
 */
function isSafeRepoRelativeArg(token: string): boolean {
    if (!token) return false;
    if (isAbsolute(token)) return false;
    if (token.startsWith('-')) return false;
    if (token.split(/[\\/]/).includes('..')) return false;
    if (/^[~$]/.test(token)) return false;
    if (/[`$;&|<>(){}]/.test(token)) return false;
    return true;
}

/** A bare short/long flag with no attached value (e.g. `-l`, `--reverse`) - never one with a separate or `=`-joined value, which this module cannot safely tell apart from a path argument. */
function isBareFlag(token: string): boolean {
    return /^-{1,2}[A-Za-z][A-Za-z-]*$/.test(token);
}

/**
 * Independently (self-)parses the non-flag argv tokens of one of
 * {@link SELF_PARSEABLE_PATH_COMMANDS} as candidate path operands.
 * Returns `null` (meaning: cannot safely parse, fail closed) if any token
 * is a flag this module cannot prove takes no separate value, an
 * unsafe/ambiguous argument (shell metacharacters, `..` traversal, `~`/`$`
 * expansion), or (for `uniq`, whose second positional argument is a write
 * target - `uniq [OPTION]... [INPUT [OUTPUT]]` - not a second file to
 * read) more than one non-flag argument. An absolute path token is
 * returned as-is (still checked by {@link evaluatePathAccess} below - not
 * rejected here) so it fails via the ordinary confinement check rather
 * than this fallback silently approving it as "not a candidate".
 */
function extractSelfParsedPathArgs(identifier: string, tokens: string[]): string[] | null {
    const args: string[] = [];
    for (const token of tokens) {
        if (token.startsWith('-')) {
            if (!isBareFlag(token)) return null;
            continue;
        }
        if (/[`$;&|<>(){}]/.test(token) || /^[~$]/.test(token)) return null;
        if (!isAbsolute(token) && token.split(/[\\/]/).includes('..')) return null;
        args.push(token);
    }
    if (identifier === 'uniq' && args.length > 1) return null;
    return args;
}

export interface ShellCommandSegmentLike {
    identifier: string;
    fullCommandText: string;
}

function evaluateShellSegment(segment: ShellCommandSegmentLike, worktreeRoot: string, hasPossiblePaths: boolean): PolicyDecision {
    const identifier = segment.identifier.trim().toLowerCase().split(/\s+/)[0] ?? '';
    const tokens = segment.fullCommandText.trim().split(/\s+/);
    const subcommand = (tokens[1] ?? '').toLowerCase();

    if (identifier === 'git') {
        if (DENIED_GIT_SUBCOMMANDS.has(subcommand)) {
            return { allowed: false, reason: `git ${subcommand} is always denied; only the deterministic host commits/deploys` };
        }
        if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
            return { allowed: false, reason: `git ${subcommand || '<none>'} is not an allowed read-only inspection subcommand` };
        }
        return { allowed: true, reason: `git ${subcommand} is an allowed read-only inspection command` };
    }
    if (!ALLOWED_BARE_IDENTIFIERS.has(identifier)) {
        return { allowed: false, reason: `'${identifier}' is not in the bounded read-only inspection command allowlist (deny by default) - no interpreter, build tool, or test runner is ever approved for the autonomous agent` };
    }

    const args = tokens.slice(1);
    if (args.length > 0) {
        if (SELF_PARSEABLE_PATH_COMMANDS.has(identifier)) {
            // Always independently self-parsed and validated, regardless
            // of whether the runtime also supplied its own `possiblePaths`
            // for this segment (checked separately, in bulk, by
            // evaluateShellRequest below). An empty (or otherwise
            // incomplete) `possiblePaths` array is never, by itself,
            // trusted as proof this command's own arguments are safe -
            // this module has no way to distinguish "there truly are no
            // paths" from "the runtime's extractor under-reported them",
            // so for this safe command subset it never relies on that
            // distinction at all.
            const parsed = extractSelfParsedPathArgs(identifier, args);
            if (parsed === null) {
                return {
                    allowed: false,
                    reason: `'${identifier}'s own arguments could not be safely parsed/validated as paths (or violate this command's own shape, e.g. uniq's single-input/single-output limit); deny by default`,
                };
            }
            for (const arg of parsed) {
                const resolved = isAbsolute(arg) ? arg : join(worktreeRoot, arg);
                const decision = evaluatePathAccess(worktreeRoot, resolved);
                if (!decision.allowed) {
                    return { allowed: false, reason: `self-parsed argument of '${identifier}' is denied: ${decision.reason}` };
                }
            }
        } else if (!hasPossiblePaths) {
            // grep/rg (and anything else outside the safe subset): their
            // arguments cannot be reliably self-parsed (pattern vs path
            // ambiguity for grep/rg specifically), so they fail closed
            // whenever the runtime supplies no possiblePaths extraction
            // to corroborate them with at all.
            return {
                allowed: false,
                reason: `no possiblePaths were supplied for '${identifier} ${args.join(' ')}' and this command's arguments cannot be safely self-parsed as paths; deny by default`,
            };
        }
    }
    return { allowed: true, reason: `${identifier} is an allowed local inspection command` };
}

export interface ShellRequestLike {
    fullCommandText: string;
    hasWriteFileRedirection: boolean;
    requestSandboxBypass?: boolean;
    managedApprovalRequired?: boolean;
    commandSegments?: ShellCommandSegmentLike[];
    commands?: Array<{ identifier: string; readOnly: boolean }>;
    /** File paths the command may read or write, per the runtime's own shell-aware extractor. */
    possiblePaths?: string[];
    /** URLs the command may access, per the runtime's own shell-aware extractor. */
    possibleUrls?: Array<{ url: string }>;
}

/**
 * Evaluates a shell permission request end to end. Every parsed command
 * segment must independently pass the allowlist; any single disallowed
 * segment (e.g. a denied command chained after an allowed one) rejects the
 * whole request. Every `possiblePath` the runtime extracted must itself
 * resolve inside the isolated worktree (resolved against `worktreeRoot`,
 * never the host process's own cwd) and pass the same blocked-pattern
 * checks reads/writes get; any `possibleUrls` entry denies the request
 * outright (no network access, ever). Pure and fully testable without a
 * real shell parser.
 */
export function evaluateShellRequest(request: ShellRequestLike, worktreeRoot: string): PolicyDecision {
    if (request.managedApprovalRequired) {
        return { allowed: false, reason: 'managed approval required; deny by default, no interactive human present' };
    }
    if (request.requestSandboxBypass) {
        return { allowed: false, reason: 'sandbox bypass requests are always denied' };
    }
    if (request.hasWriteFileRedirection) {
        return { allowed: false, reason: 'file write redirection is always denied; use the write/apply_patch tool instead' };
    }
    if (DANGEROUS_TEXT_PATTERN.test(request.fullCommandText)) {
        return { allowed: false, reason: 'command substitution/backtick/eval constructs are always denied' };
    }
    if (request.possibleUrls && request.possibleUrls.length > 0) {
        return { allowed: false, reason: 'shell command may access a URL; network access is always denied for the autonomous agent' };
    }

    const hasControlOperators = CONTROL_OPERATOR_PATTERN.test(request.fullCommandText);
    // Whether the runtime supplied its own shell-aware path extraction at
    // all (even an empty array counts as "supplied" - trust that there
    // simply were no paths). Only when this is completely absent does
    // evaluateShellSegment ever attempt to self-parse a segment's own
    // arguments as paths, and only for the narrow command subset where
    // that is unambiguous - see SELF_PARSEABLE_PATH_COMMANDS.
    const hasPossiblePaths = request.possiblePaths !== undefined;
    let segments: ShellCommandSegmentLike[];

    if (request.commandSegments && request.commandSegments.length > 0) {
        segments = request.commandSegments;
        // Defense in depth: if the raw text still looks like it chains more
        // commands than the runtime actually segmented, the parse is
        // untrustworthy - fail closed rather than silently vetting fewer
        // commands than are actually present.
        if (hasControlOperators && segments.length < 2) {
            return {
                allowed: false,
                reason: 'command text contains control operators/chaining but only one command segment was parsed; deny by default',
            };
        }
    } else {
        // No parsed segments at all. This fallback may only ever approve
        // exactly one unambiguous, genuinely read-only bare utility - never
        // git (whose safety depends on the specific subcommand, which this
        // fallback cannot see), and never anything if the raw text shows
        // any sign of chaining.
        if (hasControlOperators) {
            return {
                allowed: false,
                reason: 'no parsed command segments and the command text contains control operators/chaining; deny by default',
            };
        }
        const commands = request.commands ?? [];
        const only = commands[0];
        if (commands.length !== 1 || !only) {
            return {
                allowed: false,
                reason: 'no parsed command segments and not exactly one parsed command identifier; deny by default',
            };
        }
        const identifier = only.identifier.trim().toLowerCase();
        if (!only.readOnly) {
            return {
                allowed: false,
                reason: `no parsed command segments and '${only.identifier}' is not reported read-only; deny by default`,
            };
        }
        if (!ALLOWED_BARE_IDENTIFIERS.has(identifier)) {
            return {
                allowed: false,
                reason: `no parsed command segments and '${only.identifier}' is not a bare read-only utility this fallback can safely approve (git requires parsed segments); deny by default`,
            };
        }
        segments = [{ identifier: only.identifier, fullCommandText: request.fullCommandText }];
    }

    if (segments.length === 0) {
        return { allowed: false, reason: 'no parsed command segments to evaluate; deny by default' };
    }
    for (const segment of segments) {
        const decision = evaluateShellSegment(segment, worktreeRoot, hasPossiblePaths);
        if (!decision.allowed) return decision;
    }

    for (const possiblePath of request.possiblePaths ?? []) {
        const resolved = isAbsolute(possiblePath) ? possiblePath : join(worktreeRoot, possiblePath);
        const decision = evaluatePathAccess(worktreeRoot, resolved);
        if (!decision.allowed) {
            return { allowed: false, reason: `shell command's possible path is denied: ${decision.reason}` };
        }
    }

    return { allowed: true, reason: 'every parsed command segment and possible path is within the bounded development allowlist' };
}

// ---------------------------------------------------------------------------
// Full permission decision (all request kinds)
// ---------------------------------------------------------------------------

/**
 * Resolves a direct read/write request's path against `worktreeRoot` when
 * it is not already absolute - the runtime is not guaranteed to always
 * hand this handler an absolute path, and a relative path must never be
 * resolved against this host process's own (arbitrary) working directory.
 */
function resolveAgainstWorktree(worktreeRoot: string, requestedPath: string): string {
    return isAbsolute(requestedPath) ? requestedPath : join(worktreeRoot, requestedPath);
}

/**
 * Pure decision function covering every {@link PermissionRequest} kind the
 * runtime can raise. Deny-by-default: only `read`/`write` (worktree-scoped)
 * and a narrow `shell` allowlist can ever be approved. Everything else -
 * mcp, url, memory, custom-tool, hook, extension-management, factory,
 * extension-permission-access - is unconditionally denied, matching the
 * agent never being given those tools/servers in the first place.
 */
export function decidePermission(worktreeRoot: string, request: PermissionRequest): PolicyDecision {
    if ('managedApprovalRequired' in request && request.managedApprovalRequired) {
        return { allowed: false, reason: 'managed approval required; deny by default, no interactive human present' };
    }
    switch (request.kind) {
        case 'read':
            if (request.requestSandboxBypass) return { allowed: false, reason: 'sandbox bypass requests are always denied' };
            return evaluatePathAccess(worktreeRoot, resolveAgainstWorktree(worktreeRoot, request.path));
        case 'write':
            if (request.requestSandboxBypass) return { allowed: false, reason: 'sandbox bypass requests are always denied' };
            return evaluatePathAccess(worktreeRoot, resolveAgainstWorktree(worktreeRoot, request.fileName));
        case 'shell':
            return evaluateShellRequest(request, worktreeRoot);
        case 'mcp':
        case 'url':
        case 'memory':
        case 'custom-tool':
        case 'hook':
        case 'extension-management':
        case 'factory':
        case 'extension-permission-access':
            return { allowed: false, reason: `'${request.kind}' requests are always denied for the autonomous development agent` };
        default:
            return { allowed: false, reason: 'unrecognized permission request kind; deny by default' };
    }
}

export interface PermissionAuditEntry {
    at: number;
    kind: string;
    allowed: boolean;
    reason: string;
}

/**
 * Builds the {@link PermissionHandler} passed to the autonomous coding
 * agent's session. `onDecision` receives an audit record of every decision
 * (approved or rejected) for the host's own logging - independent of, and
 * not required by, the SDK's tool hooks.
 */
export function createAutonomousPermissionHandler(
    worktreeRoot: string,
    onDecision?: (entry: PermissionAuditEntry) => void
): PermissionHandler {
    return (request: PermissionRequest) => {
        const decision = decidePermission(worktreeRoot, request);
        onDecision?.({ at: Date.now(), kind: request.kind, allowed: decision.allowed, reason: decision.reason });
        return decision.allowed
            ? { kind: 'approve-once' }
            : { kind: 'reject', feedback: decision.reason };
    };
}
