import { describe, expect, test } from 'bun:test';
import type { ModelInfo } from '@github/copilot-sdk';
import {
    AUTONOMOUS_DEVELOPMENT_MODEL,
    buildAutonomousDevelopmentPrompt,
    defaultAutonomousBaseDirectory,
    pickAutonomousModel,
} from '../lib/autonomousDevelopmentAgent';

function model(id: string): ModelInfo {
    return { id, name: id, capabilities: {} as ModelInfo['capabilities'] };
}

describe('pickAutonomousModel', () => {
    test('picks the preferred model when it is available', () => {
        const models = [model('gpt-5.6-terra'), model('gpt-5.5')];
        expect(pickAutonomousModel(models)).toBe(AUTONOMOUS_DEVELOPMENT_MODEL);
    });

    test('falls back safely to the first available fallback when the preferred model is unavailable', () => {
        const models = [model('claude-sonnet-5'), model('gpt-5-mini')];
        expect(pickAutonomousModel(models)).toBe('claude-sonnet-5');
    });

    test('respects fallback ordering: earlier fallbacks win over later ones', () => {
        const models = [model('gpt-5.6-luna'), model('claude-sonnet-5')];
        expect(pickAutonomousModel(models)).toBe('gpt-5.6-luna');
    });

    test('throws (never silently picks an arbitrary model) when nothing in the preferred/fallback list is available', () => {
        const models = [model('some-unrelated-model')];
        expect(() => pickAutonomousModel(models)).toThrow('no available model');
    });

    test('supports custom preferred/fallback lists for testing', () => {
        const models = [model('custom-fallback')];
        expect(pickAutonomousModel(models, 'custom-preferred', ['custom-fallback'])).toBe('custom-fallback');
    });
});

describe('buildAutonomousDevelopmentPrompt', () => {
    test('embeds the issue fields and architecture boundaries', () => {
        const prompt = buildAutonomousDevelopmentPrompt({
            issueId: 'issue-1',
            category: 'systemic_code',
            severity: 'high',
            title: 'sdk/API.md is stale',
            description: 'Generated docs drifted from source.',
            evidence: ['sdk/API.md:1'],
            attempts: 2,
            recurrenceCount: 1,
            relatedReviewSummary: 'The reviewer flagged recurring doc drift.',
            architectureBoundaries: 'Development layer owns repo repair; strategist/operator stay tool-free.',
            recentSystemMetrics: { issues: { open: 3 } },
        });
        expect(prompt).toContain('issue-1');
        expect(prompt).toContain('systemic_code');
        expect(prompt).toContain('sdk/API.md is stale');
        expect(prompt).toContain('recurring doc drift');
        expect(prompt).toContain('Development layer owns repo repair');
        expect(prompt).toContain('"open":3');
    });

    test('omits the related review section entirely when there is none', () => {
        const prompt = buildAutonomousDevelopmentPrompt({
            issueId: 'issue-2',
            category: 'failure',
            severity: 'medium',
            title: 't',
            description: 'd',
            evidence: [],
            attempts: 0,
            recurrenceCount: 0,
            relatedReviewSummary: null,
            architectureBoundaries: 'boundaries',
            recentSystemMetrics: {},
        });
        expect(prompt).not.toContain('related_development_review_summary');
    });
});

describe('defaultAutonomousBaseDirectory', () => {
    test('places the runtime directory under the ignored DayTrader data tree, keyed by work id', () => {
        const path = defaultAutonomousBaseDirectory('/repo', 'maint-123');
        expect(path).toBe('/repo/bots/DayTrader/data/copilot-autonomous-runtime/maint-123');
    });
});
