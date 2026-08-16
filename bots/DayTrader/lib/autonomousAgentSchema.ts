// DayTrader - Autonomous Development Agent Result Schema
//
// The autonomous coding agent (see autonomousDevelopmentAgent.ts) has full
// tool access inside its isolated worktree, but its *final* answer to the
// host is still a strict, deterministically-validated JSON object - the
// same trust boundary pattern as the tool-free development reviewer
// (developmentSchema.ts). The host never trusts prose; it parses this
// object and otherwise inspects `git status`/`git diff` itself.

export type AutonomousAgentOutcome = 'resolved' | 'already_resolved' | 'failed' | 'requires_direction';

/**
 * The exact, closed set of reasons a technical issue may ever be re-routed
 * to a human. `null` for every outcome except `requires_direction`, where
 * it is mandatory and must be one of the other three values - never an
 * open-ended "I'm not sure" escape hatch for ordinary technical difficulty.
 */
export type AutonomousAgentDirectionKind = 'credentials' | 'external_authorization' | 'irreversible_policy' | null;

export interface AutonomousAgentResult {
    outcome: AutonomousAgentOutcome;
    /** Concise human-readable summary of what was investigated/changed. */
    summary: string;
    /** Root cause the agent identified, if any. */
    rootCause: string | null;
    /** Focused checks the agent itself ran (e.g. "bun test bots/DayTrader/test/foo.test.ts"). */
    testsRun: string[];
    /**
     * Only meaningful for outcome='requires_direction': the specific
     * high-level product/game direction question, missing credential/
     * external authorization, or irreversible policy choice a human must
     * make. Must never describe ordinary technical uncertainty - the agent
     * is instructed to keep trying / report 'failed' for that instead.
     */
    humanQuestion: string | null;
    /**
     * Only meaningful for outcome='requires_direction': which of the three
     * closed reasons this is. Required whenever outcome='requires_direction'
     * (never null there) and must be null for every other outcome.
     */
    directionKind: AutonomousAgentDirectionKind;
}

function record(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${field} must be an object`);
    }
    return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
    if (typeof value !== 'string') throw new Error(`${field} must be a string`);
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > max) {
        throw new Error(`${field} must contain 1-${max} characters`);
    }
    return normalized;
}

function nullableText(value: unknown, field: string, max: number): string | null {
    if (value === null || value === undefined) return null;
    return text(value, field, max);
}

function strings(value: unknown, field: string, maxItems: number): string[] {
    if (!Array.isArray(value) || value.length > maxItems) {
        throw new Error(`${field} must contain at most ${maxItems} items`);
    }
    return value.map((item, index) => text(item, `${field}[${index}]`, 400));
}

function jsonObject(textValue: string): unknown {
    const normalized = textValue.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
        return JSON.parse(normalized);
    } catch (directError) {
        const start = normalized.indexOf('{');
        const end = normalized.lastIndexOf('}');
        if (start < 0 || end <= start) throw directError;
        return JSON.parse(normalized.slice(start, end + 1));
    }
}

const VALID_OUTCOMES: AutonomousAgentOutcome[] = ['resolved', 'already_resolved', 'failed', 'requires_direction'];
const VALID_DIRECTION_KINDS: Exclude<AutonomousAgentDirectionKind, null>[] = [
    'credentials',
    'external_authorization',
    'irreversible_policy',
];

export function parseAutonomousAgentResult(value: unknown): AutonomousAgentResult {
    const data = record(value, 'autonomous agent result');
    const outcomeValue = String(data.outcome).toLowerCase();
    if (!VALID_OUTCOMES.includes(outcomeValue as AutonomousAgentOutcome)) {
        throw new Error(`outcome must be one of ${VALID_OUTCOMES.join(', ')}`);
    }
    const outcome = outcomeValue as AutonomousAgentOutcome;
    const humanQuestion = nullableText(data.humanQuestion, 'humanQuestion', 800);

    let directionKind: AutonomousAgentDirectionKind = null;
    if (data.directionKind !== null && data.directionKind !== undefined) {
        const directionKindValue = String(data.directionKind).toLowerCase();
        if (!VALID_DIRECTION_KINDS.includes(directionKindValue as Exclude<AutonomousAgentDirectionKind, null>)) {
            throw new Error(`directionKind must be one of ${VALID_DIRECTION_KINDS.join(', ')}, or null`);
        }
        directionKind = directionKindValue as Exclude<AutonomousAgentDirectionKind, null>;
    }

    if (outcome === 'requires_direction') {
        if (!humanQuestion) {
            throw new Error('requires_direction must include a non-empty humanQuestion');
        }
        if (directionKind === null) {
            throw new Error(`requires_direction must include a directionKind (one of ${VALID_DIRECTION_KINDS.join(', ')})`);
        }
    } else if (directionKind !== null) {
        throw new Error(`directionKind must be null when outcome is not requires_direction (got '${outcome}' with directionKind='${directionKind}')`);
    }

    return {
        outcome,
        summary: text(data.summary, 'summary', 800),
        rootCause: nullableText(data.rootCause, 'rootCause', 800),
        testsRun: strings(data.testsRun ?? [], 'testsRun', 20),
        humanQuestion,
        directionKind,
    };
}

export function parseAutonomousAgentResultText(value: string): AutonomousAgentResult {
    return parseAutonomousAgentResult(jsonObject(value));
}

/** Keyword-plausibility patterns a genuine direction request of each kind should match somewhere in its summary/humanQuestion. */
const DIRECTION_KIND_KEYWORDS: Record<Exclude<AutonomousAgentDirectionKind, null>, RegExp> = {
    credentials: /credential|api[\s-]?key|token|password|secret\b|\bauth(entication)?\b/i,
    external_authorization: /authoriz|permission|external (service|account|api|system)|access grant|third[\s-]?party/i,
    irreversible_policy: /\bpolicy\b|irreversible|product decision|design decision|business decision|game[\s-]?design|policy choice/i,
};

export interface DirectionCredibilityResult {
    ok: boolean;
    reason?: string;
}

/**
 * Host-side plausibility gate for a `requires_direction` outcome, layered
 * on top of (never a replacement for) the schema's own structural
 * validation. A well-formed but *incredible* direction request - e.g.
 * `directionKind='credentials'` with a `humanQuestion` that reads like
 * ordinary technical uncertainty - must still never reach a human: the
 * deterministic host treats it as an untrustworthy/malformed direction
 * request and falls back to an ordinary technical failure (bounded retry),
 * matching "any malformed or ordinary technical direction request becomes
 * failed+retry, not human owner".
 */
export function assessDirectionRequestCredibility(
    result: Pick<AutonomousAgentResult, 'outcome' | 'directionKind' | 'humanQuestion' | 'summary'>
): DirectionCredibilityResult {
    if (result.outcome !== 'requires_direction') {
        return { ok: false, reason: `outcome '${result.outcome}' is not requires_direction` };
    }
    if (result.directionKind === null) {
        return { ok: false, reason: 'directionKind is missing/null' };
    }
    if (!result.humanQuestion || !result.humanQuestion.trim()) {
        return { ok: false, reason: 'humanQuestion is empty' };
    }
    const pattern = DIRECTION_KIND_KEYWORDS[result.directionKind];
    if (!pattern) return { ok: false, reason: `unrecognized directionKind '${result.directionKind}'` };
    const haystack = `${result.humanQuestion} ${result.summary ?? ''}`;
    if (!pattern.test(haystack)) {
        return {
            ok: false,
            reason: `humanQuestion/summary do not plausibly match directionKind '${result.directionKind}' (reads like ordinary technical uncertainty)`,
        };
    }
    return { ok: true };
}
