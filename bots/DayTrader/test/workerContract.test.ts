import { describe, expect, test } from 'bun:test';
import {
    APPROVED_RECIPES,
    buildRestrictedEnv,
    findApprovedRecipeForIssue,
    getApprovedRecipe,
    isCommandAllowed,
    isPathAllowed,
    resolveRecipeCommand,
    listApprovedRecipes,
} from '../maintenance/workerContract';
import type { IssueRecord } from '../lib/issueRegistry';

function issue(overrides: Partial<IssueRecord> = {}): IssueRecord {
    return {
        id: 'issue-1',
        fingerprint: 'fp-1',
        status: 'detected',
        ownerLayer: 'development',
        severity: 'medium',
        category: 'systemic_code',
        title: 'sdk/API.md drifted from source doc comments',
        description: 'generate-api-docs --check reports drift',
        evidence: [],
        deadlineAt: null,
        attempts: 0,
        resolutionEvidence: null,
        relatedWorkflowId: null,
        relatedReviewId: null,
        recurrenceCount: 0,
        firstDetectedAt: Date.now(),
        lastDetectedAt: Date.now(),
        resolvedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        nextRetryAt: null,
        lastEvidenceAt: null,
        ...overrides,
    };
}

describe('maintenance worker contract - recipe registry', () => {
    test('the regenerate-api-docs recipe is registered with a bounded contract', () => {
        const recipe = getApprovedRecipe('regenerate-api-docs');
        expect(recipe).not.toBeNull();
        expect(recipe?.eligibleCategories).toEqual(['systemic_code']);
        expect(recipe?.commands.length).toBeGreaterThan(0);
        expect(recipe?.testCommand.length).toBeGreaterThan(0);
        expect(recipe?.maxDurationMs).toBeGreaterThan(0);
    });

    test('getApprovedRecipe returns null for an unknown id (never invents a recipe)', () => {
        expect(getApprovedRecipe('delete-everything')).toBeNull();
    });

    test('listApprovedRecipes returns every registered recipe', () => {
        expect(listApprovedRecipes().length).toBe(Object.keys(APPROVED_RECIPES).length);
    });
});

describe('maintenance worker contract - deterministic issue matching', () => {
    test('finds the matching recipe for an eligible, matching issue', () => {
        const recipe = findApprovedRecipeForIssue(issue());
        expect(recipe?.id).toBe('regenerate-api-docs');
    });

    test('never matches an issue outside systemic_code, regardless of title text', () => {
        expect(findApprovedRecipeForIssue(issue({ category: 'failure' }))).toBeNull();
    });

    test('never matches a systemic_code issue whose text does not reference the recipe target', () => {
        expect(
            findApprovedRecipeForIssue(issue({ title: 'Something unrelated to docs', description: 'no match here' }))
        ).toBeNull();
    });
});

describe('maintenance worker contract - path and command allowlists', () => {
    const recipe = getApprovedRecipe('regenerate-api-docs')!;

    test('allows the exact allowlisted path', () => {
        expect(isPathAllowed(recipe, 'sdk/API.md')).toBe(true);
    });

    test('rejects a path outside the allowlist even if superficially similar', () => {
        expect(isPathAllowed(recipe, 'sdk/API.md.secret-backdoor')).toBe(false);
        expect(isPathAllowed(recipe, 'bots/DayTrader/lib/operatorStore.ts')).toBe(false);
    });

    test('allows the exact allowlisted commands and the test command', () => {
        expect(isCommandAllowed(recipe, ['$BUN', 'sdk/generate-api-docs.ts'])).toBe(true);
        expect(isCommandAllowed(recipe, ['$BUN', 'sdk/generate-api-docs.ts', '--check'])).toBe(true);
    });

    test('rejects any command not byte-for-byte in the allowlist', () => {
        expect(isCommandAllowed(recipe, ['$BUN', 'sdk/generate-api-docs.ts', '--force'])).toBe(false);
        expect(isCommandAllowed(recipe, ['rm', '-rf', '/'])).toBe(false);
        expect(isCommandAllowed(recipe, ['sh', '-c', 'bun sdk/generate-api-docs.ts'])).toBe(false);
    });

    test('resolves the Bun placeholder without relying on PATH', () => {
        expect(resolveRecipeCommand(['$BUN', 'script.ts'], '/opt/bun')).toEqual(['/opt/bun', 'script.ts']);
    });
});

describe('maintenance worker contract - restricted environment', () => {
    test('only allowlisted environment keys ever reach a worker command', () => {
        const restricted = buildRestrictedEnv(
            {
                PATH: '/usr/bin',
                HOME: '/home/bot',
                BOT_PASSWORD: 'super-secret',
                OPENAI_API_KEY: 'sk-secret',
                SERVER: 'rs-sdk-demo.fly.dev',
            } as NodeJS.ProcessEnv,
            '/tmp/maintenance-home'
        );
        expect(restricted.PATH).toBe('/usr/bin');
        expect(restricted.HOME).toBe('/tmp/maintenance-home');
        expect(restricted.BOT_PASSWORD).toBeUndefined();
        expect(restricted.OPENAI_API_KEY).toBeUndefined();
        expect(restricted.SERVER).toBeUndefined();
    });

    test('always includes a fixed host git author/committer identity, independent of the isolated HOME/any real ~/.gitconfig', () => {
        const restricted = buildRestrictedEnv({ PATH: '/usr/bin' } as NodeJS.ProcessEnv, '/tmp/isolated-home-with-no-gitconfig');
        const authorName = restricted.GIT_AUTHOR_NAME ?? '';
        const authorEmail = restricted.GIT_AUTHOR_EMAIL ?? '';
        expect(authorName).toBeTruthy();
        expect(authorEmail).toBeTruthy();
        expect(restricted.GIT_COMMITTER_NAME ?? '').toBe(authorName);
        expect(restricted.GIT_COMMITTER_EMAIL ?? '').toBe(authorEmail);
    });
});
