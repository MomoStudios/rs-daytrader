import {
    parseOperatorWorkflow,
    type OperatorWorkflow,
} from './operatorSchema';

export type DevelopmentAudience = 'strategist' | 'operator' | 'both';

export interface DevelopmentResearchPlan {
    focus: string;
    queries: string[];
}

export interface DevelopmentFinding {
    severity: 'low' | 'medium' | 'high';
    kind: 'failure' | 'upgrade' | 'policy_gap' | 'knowledge_gap' | 'systemic_code' | 'success';
    title: string;
    evidenceRefs: string[];
    diagnosis: string;
    recommendation: string;
    target: 'strategist' | 'operator' | 'workflow' | 'development' | 'observer';
}

export interface DevelopmentKnowledgeUpdate {
    audience: DevelopmentAudience;
    topic: string;
    content: string;
    evidenceRefs: string[];
    confidence: number;
}

export interface DevelopmentReview {
    summary: string;
    health: 'healthy' | 'degraded' | 'blocked';
    findings: DevelopmentFinding[];
    knowledgeUpdates: DevelopmentKnowledgeUpdate[];
    workflowProposals: OperatorWorkflow[];
    noActionReason: string | null;
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

function strings(value: unknown, field: string, maxItems: number): string[] {
    if (!Array.isArray(value) || value.length > maxItems) {
        throw new Error(`${field} must contain at most ${maxItems} items`);
    }
    return value.map((item, index) => text(item, `${field}[${index}]`, 240));
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

export function parseDevelopmentResearchPlan(value: unknown): DevelopmentResearchPlan {
    const data = record(value, 'research plan');
    const queries = strings(data.queries, 'queries', 12);
    if (queries.length === 0) throw new Error('queries must not be empty');
    return {
        focus: text(data.focus, 'focus', 400),
        queries,
    };
}

export function parseDevelopmentResearchPlanText(value: string): DevelopmentResearchPlan {
    return parseDevelopmentResearchPlan(jsonObject(value));
}

export function parseDevelopmentReview(value: unknown): DevelopmentReview {
    const data = record(value, 'development review');
    const healthValue = String(data.health).toLowerCase();
    const health =
        ['healthy', 'good', 'ok', 'stable', 'improving'].includes(healthValue)
            ? 'healthy'
            : ['degraded', 'warning', 'mixed'].includes(healthValue)
              ? 'degraded'
              : ['blocked', 'critical', 'failing'].includes(healthValue)
                ? 'blocked'
                : null;
    if (!health) {
        throw new Error('health is invalid');
    }
    if (!Array.isArray(data.findings) || data.findings.length > 20) {
        throw new Error('findings must contain at most 20 items');
    }
    if (!Array.isArray(data.knowledgeUpdates) || data.knowledgeUpdates.length > 20) {
        throw new Error('knowledgeUpdates must contain at most 20 items');
    }
    if (!Array.isArray(data.workflowProposals) || data.workflowProposals.length > 5) {
        throw new Error('workflowProposals must contain at most 5 items');
    }

    const findings = data.findings.map((value, index): DevelopmentFinding => {
        const finding = record(value, `findings[${index}]`);
        const severityValue = String(finding.severity).toLowerCase();
        const severity =
            ['low', 'info', 'informational', 'minor'].includes(severityValue)
                ? 'low'
                : ['medium', 'warning', 'moderate'].includes(severityValue)
                  ? 'medium'
                  : ['high', 'critical', 'major'].includes(severityValue)
                    ? 'high'
                    : null;
        if (!severity) {
            throw new Error('finding.severity is invalid');
        }
        if (!['failure', 'upgrade', 'policy_gap', 'knowledge_gap', 'systemic_code', 'success'].includes(String(finding.kind))) {
            throw new Error('finding.kind is invalid');
        }
        if (!['strategist', 'operator', 'workflow', 'development', 'observer'].includes(String(finding.target))) {
            throw new Error('finding.target is invalid');
        }
        return {
            severity,
            kind: finding.kind as DevelopmentFinding['kind'],
            title: text(finding.title, 'finding.title', 160),
            evidenceRefs: strings(finding.evidenceRefs, 'finding.evidenceRefs', 12),
            diagnosis: text(finding.diagnosis, 'finding.diagnosis', 600),
            recommendation: text(finding.recommendation, 'finding.recommendation', 600),
            target: finding.target as DevelopmentFinding['target'],
        };
    });

    const knowledgeUpdates = data.knowledgeUpdates.map((value, index): DevelopmentKnowledgeUpdate => {
        const update = record(value, `knowledgeUpdates[${index}]`);
        if (!['strategist', 'operator', 'both'].includes(String(update.audience))) {
            throw new Error('knowledge audience is invalid');
        }
        if (
            typeof update.confidence !== 'number' ||
            !Number.isFinite(update.confidence) ||
            update.confidence < 0 ||
            update.confidence > 100
        ) {
            throw new Error('knowledge confidence must be 0-100');
        }
        return {
            audience: update.audience as DevelopmentAudience,
            topic: text(update.topic, 'knowledge.topic', 120),
            content: text(update.content, 'knowledge.content', 1_200),
            evidenceRefs: strings(update.evidenceRefs, 'knowledge.evidenceRefs', 12),
            confidence: Math.round(update.confidence),
        };
    });

    const workflowProposals = data.workflowProposals.map((proposal, index) => {
        const parsed = parseOperatorWorkflow(proposal);
        if (!parsed) throw new Error(`workflowProposals[${index}] must not be null`);
        return parsed;
    });

    return {
        summary: text(data.summary, 'summary', 800),
        health,
        findings,
        knowledgeUpdates,
        workflowProposals,
        noActionReason:
            data.noActionReason === null
                ? null
                : text(data.noActionReason, 'noActionReason', 500),
    };
}

export function parseDevelopmentReviewText(value: string): DevelopmentReview {
    return parseDevelopmentReview(jsonObject(value));
}
