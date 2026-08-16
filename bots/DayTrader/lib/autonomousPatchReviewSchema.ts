// DayTrader - Autonomous Patch Review Result Schema
//
// The independent AutonomousPatchReviewer (see autonomousPatchReviewer.ts)
// answers in the same strict, deterministically-validated JSON pattern as
// every other LLM output this codebase trusts (developmentSchema.ts,
// autonomousAgentSchema.ts): the host never trusts free-form prose, only a
// parsed object with a fixed shape.

export interface AutonomousPatchReviewResult {
    approved: boolean;
    /** Concise human-readable justification for the verdict. */
    summary: string;
    /** Specific concerns found, if any. Empty when approved with nothing notable. */
    findings: string[];
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

function boolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
    return value;
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

export function parseAutonomousPatchReviewResult(value: unknown): AutonomousPatchReviewResult {
    const data = record(value, 'autonomous patch review result');
    const approved = boolean(data.approved, 'approved');
    const findings = strings(data.findings ?? [], 'findings', 20);
    if (!approved && findings.length === 0) {
        throw new Error('a rejected patch review must include at least one finding');
    }
    return {
        approved,
        summary: text(data.summary, 'summary', 800),
        findings,
    };
}

export function parseAutonomousPatchReviewResultText(value: string): AutonomousPatchReviewResult {
    return parseAutonomousPatchReviewResult(jsonObject(value));
}
