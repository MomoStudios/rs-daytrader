import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type {
    DevelopmentKnowledgeUpdate,
    DevelopmentReview,
} from './developmentSchema';
import { proposeWorkflowCandidate } from './workflowCandidateStore';
import { recordIssue } from './issueRegistry';
import { findingsToIssueInputs } from './developmentIssueBridge';
import { log } from './logger';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const STORE_PATH = join(DATA_DIR, 'development.json');
const TEMP_PATH = `${STORE_PATH}.tmp`;
const INTERVAL_MS = 30 * 60 * 1000;

export interface DevelopmentRequest {
    id: string;
    prompt: string | null;
    status: 'pending' | 'running' | 'completed' | 'failed';
    createdAt: number;
    startedAt: number | null;
    completedAt: number | null;
    error: string | null;
    reviewId: string | null;
}

export interface ManagedKnowledge extends DevelopmentKnowledgeUpdate {
    id: string;
    status: 'active' | 'superseded';
    createdAt: number;
    reviewId: string;
    expiresAt: number | null;
}

export interface StoredDevelopmentReview {
    id: string;
    createdAt: number;
    trigger: 'periodic' | 'on_demand';
    prompt: string | null;
    traceWindow: { startTs: number; endTs: number; eventCount: number; hours: number };
    researchQueries: string[];
    evidenceSources: string[];
    review: DevelopmentReview;
}

export interface DevelopmentState {
    lastReviewAt: number;
    nextReviewAt: number;
    running: boolean;
    requests: DevelopmentRequest[];
    reviews: StoredDevelopmentReview[];
    knowledge: ManagedKnowledge[];
}

function defaults(): DevelopmentState {
    return {
        lastReviewAt: 0,
        nextReviewAt: Date.now(),
        running: false,
        requests: [],
        reviews: [],
        knowledge: [],
    };
}

function load(): DevelopmentState {
    if (!existsSync(STORE_PATH)) return defaults();
    try {
        const parsed = {
            ...defaults(),
            ...(JSON.parse(readFileSync(STORE_PATH, 'utf8')) as Partial<DevelopmentState>),
        };
        parsed.knowledge = parsed.knowledge.map(note => ({
            ...note,
            expiresAt:
                note.expiresAt ??
                (/\bcurrent\b|at the review boundary|\bcurrently holds?\b/i.test(
                    `${note.topic} ${note.content}`
                )
                    ? note.createdAt + 30 * 60 * 1000
                    : null),
        }));
        return parsed;
    } catch (error) {
        console.warn(`[developmentStore] Could not read store: ${error}`);
        return defaults();
    }
}

function save(value: DevelopmentState): void {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TEMP_PATH, JSON.stringify(value, null, 2));
    renameSync(TEMP_PATH, STORE_PATH);
}

export function getDevelopmentState(): DevelopmentState {
    return load();
}

export function enqueueDevelopmentReview(prompt?: string): DevelopmentRequest {
    const normalized = prompt?.replace(/\s+/g, ' ').trim() || null;
    if (normalized && normalized.length > 1_000) throw new Error('Review prompt exceeds 1000 characters');
    const state = load();
    const request: DevelopmentRequest = {
        id: `devreq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        prompt: normalized,
        status: 'pending',
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        error: null,
        reviewId: null,
    };
    state.requests.push(request);
    if (state.requests.length > 100) state.requests.splice(0, state.requests.length - 100);
    save(state);
    return request;
}

export function claimDevelopmentWork(): {
    trigger: 'periodic' | 'on_demand';
    request: DevelopmentRequest | null;
} | null {
    const state = load();
    if (state.running) return null;
    const request = state.requests.find(item => item.status === 'pending') ?? null;
    if (!request && Date.now() < state.nextReviewAt) return null;
    state.running = true;
    if (request) {
        request.status = 'running';
        request.startedAt = Date.now();
    }
    save(state);
    return { trigger: request ? 'on_demand' : 'periodic', request };
}

export function completeDevelopmentWork(input: {
    trigger: 'periodic' | 'on_demand';
    requestId?: string;
    prompt: string | null;
    traceWindow: StoredDevelopmentReview['traceWindow'];
    researchQueries: string[];
    evidenceSources: string[];
    review: DevelopmentReview;
}): StoredDevelopmentReview {
    const state = load();
    const id = `devreview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stored: StoredDevelopmentReview = {
        id,
        createdAt: Date.now(),
        trigger: input.trigger,
        prompt: input.prompt,
        traceWindow: input.traceWindow,
        researchQueries: input.researchQueries,
        evidenceSources: input.evidenceSources,
        review: input.review,
    };
    state.reviews.push(stored);
    if (state.reviews.length > 50) state.reviews.splice(0, state.reviews.length - 50);

    for (const update of input.review.knowledgeUpdates) {
        for (const existing of state.knowledge) {
            if (
                existing.status === 'active' &&
                existing.topic.toLowerCase() === update.topic.toLowerCase() &&
                (existing.audience === update.audience ||
                    existing.audience === 'both' ||
                    update.audience === 'both')
            ) {
                existing.status = 'superseded';
            }
        }
        state.knowledge.push({
            ...update,
            id: `devnote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            status: 'active',
            createdAt: Date.now(),
            reviewId: id,
            expiresAt: /\bcurrent\b|at the review boundary|\bcurrently holds?\b/i.test(
                `${update.topic} ${update.content}`
            )
                ? Date.now() + 30 * 60 * 1000
                : null,
        });
    }
    if (state.knowledge.length > 200) state.knowledge.splice(0, state.knowledge.length - 200);

    for (const workflow of input.review.workflowProposals) {
        // Development review proposals are trusted-deterministic
        // translations of a tool-free LLM's structured output - they must
        // never land directly in the reusable production registry. Every
        // one becomes a workflow candidate that still has to pass static
        // verification and prove itself in canary executions.
        proposeWorkflowCandidate({ workflow, source: 'development_review', relatedReviewId: id });
    }

    const issueIds: string[] = [];
    for (const issueInput of findingsToIssueInputs(input.review.findings, id)) {
        const issue = recordIssue(issueInput);
        issueIds.push(issue.id);
    }
    if (issueIds.length > 0) {
        log('development_issue', { reviewId: id, issueIds, findingCount: input.review.findings.length });
    }

    if (input.requestId) {
        const request = state.requests.find(item => item.id === input.requestId);
        if (request) {
            request.status = 'completed';
            request.completedAt = Date.now();
            request.reviewId = id;
        }
    }
    state.running = false;
    state.lastReviewAt = Date.now();
    state.nextReviewAt = Date.now() + INTERVAL_MS;
    save(state);
    return stored;
}

export function failDevelopmentWork(requestId: string | undefined, error: unknown): void {
    const state = load();
    if (requestId) {
        const request = state.requests.find(item => item.id === requestId);
        if (request) {
            request.status = 'failed';
            request.completedAt = Date.now();
            request.error = String(error);
        }
    }
    state.running = false;
    state.nextReviewAt = Math.min(state.nextReviewAt, Date.now() + 5 * 60 * 1000);
    save(state);
}

export function activeDevelopmentKnowledge(
    audience: 'strategist' | 'operator',
    limit = 30
): ManagedKnowledge[] {
    return load()
        .knowledge.filter(
            note =>
                note.status === 'active' &&
                (note.expiresAt === null || note.expiresAt > Date.now()) &&
                (note.audience === audience || note.audience === 'both')
        )
        .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
        .slice(0, limit);
}
