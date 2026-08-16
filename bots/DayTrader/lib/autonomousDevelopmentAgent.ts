// DayTrader - Autonomous Development Agent
//
// A tool-enabled coding agent that investigates and repairs unknown
// technical defects directly - unlike DevelopmentBrain (tool-free review
// that only emits structured findings), this agent has full built-in
// coding tools (read/write/shell) but is confined to one isolated git
// worktree by a deny-by-default PermissionHandler
// (autonomousPermissionHandler.ts). It never has MCP/network tools,
// config/instruction discovery, session persistence, extensions, or a
// user-input tool - it must resolve technical uncertainty itself or report
// `failed`/`requires_direction`, never pause to ask a human how to write
// the code.
//
// The agent's own final answer is untrusted prose until it is parsed as
// strict JSON (autonomousAgentSchema.ts). The deterministic host
// (maintenance/autonomousWorkerRunner.ts) independently inspects `git
// status`/`git diff`, runs the mandatory full gate, and owns every commit -
// nothing the agent claims is taken at face value.

import { CopilotClient, ToolSet, type CopilotSession, type ModelInfo, type SessionHooks } from '@github/copilot-sdk';
import { mkdirSync } from 'fs';
import { join } from 'path';
import {
    parseAutonomousAgentResultText,
    type AutonomousAgentResult,
} from './autonomousAgentSchema';
import { createAutonomousPermissionHandler, type PermissionAuditEntry } from '../maintenance/autonomousPermissionHandler';

export const AUTONOMOUS_DEVELOPMENT_MODEL = 'gpt-5.6-terra';
/** Tried in order if the preferred model is unavailable in this environment. */
export const AUTONOMOUS_MODEL_FALLBACKS = ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5', 'claude-sonnet-5'];
const SEND_AND_WAIT_TIMEOUT_MS = 15 * 60_000;

const SYSTEM_MESSAGE = `
You are DayTrader's autonomous development agent. You have full read/write/
shell tool access, but ONLY inside one isolated git worktree checked out from
this repository - every tool call is gated by a deny-by-default permission
policy that confines you there and blocks .git, node_modules, credentials,
private keys, and every runtime data store.

Your job for the single issue described in the prompt:
- investigate the root cause using the repository, tests, and any evidence
  given to you (do not guess; read the actual affected code and tests);
- make the smallest correct fix: edit source/docs/tests as needed;
- reason carefully about correctness yourself by reading the affected code
  and tests closely - you cannot compile, type-check, or run tests
  yourself (see the boundary below); the deterministic host always runs
  the mandatory pinned verification gate (full typecheck plus the full
  test suite, in an isolated sandbox) after you finish, and that is the
  only thing that ever validates your change;
- if the issue no longer reproduces on the current code (already fixed),
  make no unnecessary changes and report that instead of inventing a diff.

Boundary - read carefully:
- Unknown technical defects must never be deferred merely because there is
  no pre-authored recipe. You are the fallback for exactly that case: dig in
  and fix it yourself.
- You may NEVER commit, push, fetch, merge, rebase, reset, checkout, or alter
  git history. Only inspect (status/diff/log/show/rev-parse). The host commits
  your working-tree changes after independently re-validating them.
- You cannot run \`bun\`, \`tsc\`, or any other interpreter/build/test-runner
  command yourself - your shell tool is confined to a small allowlist of
  genuinely read-only local inspection commands (cat/grep/rg/head/tail/ls/
  wc/sort/uniq/diff/pwd/test, plus read-only git inspection) and none of
  them can execute project code. This is intentional, not a bug: only the
  deterministic host ever executes a compiler or test runner, always
  inside its own sandboxed pinned verification gate, never the agent
  directly. Do not waste turns attempting \`bun test\`/\`tsc\`/\`bun run\` -
  every such attempt is denied; read the code carefully instead and trust
  the host's post-hoc verification to catch what you could not run
  yourself.
- You have no network, no MCP tools, no user-input/ask-the-user tool, and no
  access to raw player chat or credentials. If a tool/permission request is
  denied, that boundary is final - work around it or report why you cannot.
- Technical uncertainty, a failing test you can't yet fix, or simply running
  out of time is normal and expected: report outcome="failed" with what you
  tried. This is NOT a reason to ask a human - a bounded retry with backoff
  will reopen this issue automatically later.
- outcome="requires_direction" is reserved ONLY for: (a) the fix genuinely
  requires a credential/external service authorization that does not exist
  in this environment, or (b) the only viable fixes are irreversible
  product/game-design/policy decisions a human must choose between (not an
  engineering judgment call). Do not use it for ordinary technical
  uncertainty, ambiguous requirements you could reasonably resolve yourself,
  or because a task is difficult. Every requires_direction outcome must set
  directionKind to exactly one of "credentials", "external_authorization",
  or "irreversible_policy" - never null - and humanQuestion must plausibly
  describe that exact kind of request. The deterministic host independently
  checks this coherence and rejects (as an ordinary technical failure, not a
  human handoff) any requires_direction outcome whose humanQuestion reads
  like ordinary technical uncertainty wearing one of these labels.

Finish your turn with EXACTLY one JSON object (no markdown fence prose
outside it) with this shape:
{"outcome":"resolved|already_resolved|failed|requires_direction",
 "summary":"...", "rootCause":"...|null", "testsRun":["..."],
 "humanQuestion":"...|null",
 "directionKind":"credentials|external_authorization|irreversible_policy|null"}
`;

export interface AutonomousDevelopmentAgentOptions {
    /** Isolated git worktree the session is confined to (workingDirectory). */
    worktreePath: string;
    /** Separate directory for Copilot SDK runtime/session data - ignored runtime storage, never committed. */
    baseDirectory: string;
    reasoningEffort?: 'medium' | 'high';
    onPermissionDecision?: (entry: PermissionAuditEntry) => void;
    onToolAudit?: (entry: ToolAuditEntry) => void;
}

export interface ToolAuditEntry {
    at: number;
    phase: 'pre' | 'post' | 'post-failure';
    toolName: string;
    success?: boolean;
}

/** Pure: picks the preferred model if available, else the first available fallback. Throws if none are available. */
export function pickAutonomousModel(
    models: ModelInfo[],
    preferred: string = AUTONOMOUS_DEVELOPMENT_MODEL,
    fallbacks: string[] = AUTONOMOUS_MODEL_FALLBACKS
): string {
    const ids = new Set(models.map(model => model.id));
    if (ids.has(preferred)) return preferred;
    for (const fallback of fallbacks) {
        if (ids.has(fallback)) return fallback;
    }
    throw new Error(
        `Autonomous development agent has no available model: preferred '${preferred}' and every fallback (${fallbacks.join(', ')}) are unavailable`
    );
}

export class AutonomousDevelopmentAgent {
    private client: CopilotClient | null = null;
    private session: CopilotSession | null = null;
    private model: string | null = null;

    constructor(private readonly options: AutonomousDevelopmentAgentOptions) {}

    getModel(): string {
        if (!this.model) throw new Error('AutonomousDevelopmentAgent has not been started');
        return this.model;
    }

    async start(): Promise<void> {
        if (this.session) return;
        mkdirSync(this.options.baseDirectory, { recursive: true });
        // Deliberately mirrors DevelopmentBrain's CopilotClient configuration
        // (full ambient env, real HOME) so the runtime's own Copilot
        // authentication keeps working exactly the same way. Bot game
        // credentials (BOT_PASSWORD, etc.) are never loaded into this
        // process's env in the first place (only bots/DayTrader/daytrader.ts
        // and the observer load bot.env), and every shell command the agent
        // can actually run is independently allowlisted by
        // autonomousPermissionHandler.ts, which excludes env/printenv and
        // any command that could dump environment variables.
        const client = new CopilotClient({
            mode: 'empty',
            workingDirectory: this.options.worktreePath,
            baseDirectory: this.options.baseDirectory,
            logLevel: 'error',
        });
        try {
            await client.start();
            const models = await client.listModels();
            const model = pickAutonomousModel(models);
            const hooks: SessionHooks = {
                onPreToolUse: input => {
                    this.options.onToolAudit?.({ at: Date.now(), phase: 'pre', toolName: input.toolName });
                },
                onPostToolUse: input => {
                    this.options.onToolAudit?.({ at: Date.now(), phase: 'post', toolName: input.toolName, success: true });
                },
                onPostToolUseFailure: input => {
                    this.options.onToolAudit?.({ at: Date.now(), phase: 'post-failure', toolName: input.toolName, success: false });
                },
            };
            this.session = await client.createSession({
                model,
                reasoningEffort: this.options.reasoningEffort ?? 'medium',
                // Full built-in coding tools (read/write/shell/...), and
                // nothing else: no MCP tools, no custom tools.
                availableTools: new ToolSet().addBuiltIn('*'),
                workingDirectory: this.options.worktreePath,
                enableConfigDiscovery: false,
                enableSessionStore: false,
                skipCustomInstructions: true,
                customAgentsLocalOnly: true,
                requestExtensions: false,
                requestCanvasRenderer: false,
                manageScheduleEnabled: false,
                coauthorEnabled: false,
                systemMessage: { content: SYSTEM_MESSAGE },
                onPermissionRequest: createAutonomousPermissionHandler(this.options.worktreePath, this.options.onPermissionDecision),
                // No onUserInputRequest: omitting it disables the ask_user
                // tool entirely, so the agent has no way to pause and wait
                // on a human for an implementation decision.
                hooks,
            });
            this.client = client;
            this.model = model;
        } catch (error) {
            await client.stop().catch(() => []);
            throw error;
        }
    }

    /**
     * Runs the agent on one issue-repair prompt and returns its parsed,
     * schema-validated result. Bounded by SEND_AND_WAIT_TIMEOUT_MS; if the
     * agent's final message isn't valid JSON, one repair turn is requested
     * before giving up (matching DevelopmentBrain's repair pattern).
     */
    async run(prompt: string): Promise<AutonomousAgentResult> {
        const session = this.requireSession();
        const response = await session.sendAndWait({ prompt }, SEND_AND_WAIT_TIMEOUT_MS);
        if (!response?.data.content) {
            throw new Error('Autonomous development agent returned no content within the time budget');
        }
        try {
            return parseAutonomousAgentResultText(response.data.content);
        } catch (firstError) {
            const repaired = await session.sendAndWait(
                {
                    prompt: [
                        `Your final answer failed deterministic validation: ${firstError}`,
                        'Do not make further code changes. Return corrected JSON only, with exactly the required shape.',
                    ].join('\n'),
                },
                60_000
            );
            if (!repaired?.data.content) throw firstError;
            return parseAutonomousAgentResultText(repaired.data.content);
        }
    }

    private requireSession(): CopilotSession {
        if (!this.session) throw new Error('AutonomousDevelopmentAgent has not been started');
        return this.session;
    }

    async stop(): Promise<void> {
        const session = this.session;
        const client = this.client;
        this.session = null;
        this.client = null;
        this.model = null;
        if (session) await session.disconnect().catch(() => undefined);
        if (client) await client.stop().catch(() => []);
    }
}

/** Builds the bounded prompt given to the agent for one issue-repair attempt. */
export function buildAutonomousDevelopmentPrompt(input: {
    issueId: string;
    category: string;
    severity: string;
    title: string;
    description: string;
    evidence: string[];
    attempts: number;
    recurrenceCount: number;
    relatedReviewSummary: string | null;
    architectureBoundaries: string;
    recentSystemMetrics: unknown;
}): string {
    return [
        'Investigate and repair the following tracked technical issue in this repository.',
        `<issue id="${input.issueId}" category="${input.category}" severity="${input.severity}" attempts="${input.attempts}" recurrenceCount="${input.recurrenceCount}">`,
        `<title>${input.title}</title>`,
        `<description>${input.description}</description>`,
        `<evidence>${JSON.stringify(input.evidence)}</evidence>`,
        '</issue>',
        input.relatedReviewSummary
            ? `<related_development_review_summary>${input.relatedReviewSummary}</related_development_review_summary>`
            : '',
        `<architecture_boundaries>${input.architectureBoundaries}</architecture_boundaries>`,
        `<recent_system_metrics>${JSON.stringify(input.recentSystemMetrics)}</recent_system_metrics>`,
        'Investigate the root cause yourself, edit code/docs/tests as needed, then finish with exactly one JSON object as instructed in your system message. You cannot run bun/tsc/tests yourself - the deterministic host runs the full sandboxed verification gate after you finish.',
    ]
        .filter(Boolean)
        .join('\n');
}

export function defaultAutonomousBaseDirectory(repoRoot: string, workId: string): string {
    return join(repoRoot, 'bots', 'DayTrader', 'data', 'copilot-autonomous-runtime', workId);
}
