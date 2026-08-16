// DayTrader - Maintenance Worker Contract
//
// The only thing an isolated maintenance worker is ever allowed to run:
// a small, explicit allowlist of (issue-category -> recipe) pairs, each
// with an exact command allowlist (argv arrays, never a shell string), a
// bounded path allowlist, and a mandatory test command. There is no LLM in
// this loop - recipes are authored and reviewed by a human, and an issue
// only becomes automatically actionable when a recipe explicitly claims
// it. Everything else stays owned/deferred instead of being silently
// "resolved" by an unattended code mutation.

import type { IssueCategory, IssueRecord } from '../lib/issueRegistry';

export interface MaintenanceRecipe {
    id: string;
    description: string;
    /** Issue categories this recipe is even allowed to consider. */
    eligibleCategories: IssueCategory[];
    /** Repo-relative path prefixes the recipe's commands may modify. */
    allowedPathPrefixes: string[];
    /** Exact allowlisted commands (argv arrays - never a shell string). */
    commands: string[][];
    /** Mandatory test command that must pass before anything is promoted. */
    testCommand: string[];
    /** Bounded wall-clock budget for the whole recipe, in milliseconds. */
    maxDurationMs: number;
    /** Automatically deploy after the isolated canary passes all checks. */
    autoPromote: boolean;
    /**
     * Deterministic (non-LLM) predicate deciding whether a specific issue
     * is what this recipe fixes. Keyword/category matching only - never
     * free-form interpretation.
     */
    matchesIssue: (issue: IssueRecord) => boolean;
}

function includesAll(haystack: string, needles: string[]): boolean {
    const lower = haystack.toLowerCase();
    return needles.every(needle => lower.includes(needle));
}

/**
 * Approved recipes. Adding a new one is a reviewed code change, not a
 * runtime decision - this is what keeps unattended repair bounded and
 * trustworthy.
 */
export const APPROVED_RECIPES: Record<string, MaintenanceRecipe> = {
    'regenerate-api-docs': {
        id: 'regenerate-api-docs',
        description: "Regenerate sdk/API.md from source doc comments when it has drifted out of date.",
        eligibleCategories: ['systemic_code'],
        allowedPathPrefixes: ['sdk/API.md'],
        commands: [['$BUN', 'sdk/generate-api-docs.ts']],
        testCommand: ['$BUN', 'sdk/generate-api-docs.ts', '--check'],
        maxDurationMs: 60_000,
        autoPromote: true,
        matchesIssue: issue =>
            issue.category === 'systemic_code' && includesAll(`${issue.title} ${issue.description}`, ['api.md']),
    },
};

export function getApprovedRecipe(id: string): MaintenanceRecipe | null {
    return APPROVED_RECIPES[id] ?? null;
}

export function listApprovedRecipes(): MaintenanceRecipe[] {
    return Object.values(APPROVED_RECIPES);
}

/** Finds an approved recipe whose deterministic predicate matches this issue, if any. */
export function findApprovedRecipeForIssue(issue: IssueRecord): MaintenanceRecipe | null {
    if (issue.category !== 'systemic_code') return null;
    return listApprovedRecipes().find(recipe => recipe.matchesIssue(issue)) ?? null;
}

function normalizeRepoPath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

/** Repo-relative path must fall under one of the recipe's allowed prefixes. */
export function isPathAllowed(recipe: MaintenanceRecipe, relativePath: string): boolean {
    const normalized = normalizeRepoPath(relativePath);
    return recipe.allowedPathPrefixes.some(
        prefix => normalized === prefix || normalized.startsWith(`${prefix}/`)
    );
}

function sameArgv(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The argv must be byte-for-byte one of the recipe's allowlisted commands. */
export function isCommandAllowed(recipe: MaintenanceRecipe, argv: string[]): boolean {
    return (
        sameArgv(argv, recipe.testCommand) || recipe.commands.some(allowed => sameArgv(allowed, argv))
    );
}

export function resolveRecipeCommand(argv: string[], bunExecutable = process.execPath): string[] {
    return argv.map(value => value === '$BUN' ? bunExecutable : value);
}

/** No credentials or runtime data ever reach a worker's child process. */
export const MAINTENANCE_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'TMPDIR'] as const;

export function buildRestrictedEnv(
    source: NodeJS.ProcessEnv = process.env,
    isolatedHome?: string
): Record<string, string> {
    const restricted: Record<string, string> = {};
    for (const key of MAINTENANCE_ENV_ALLOWLIST) {
        const value = source[key];
        if (value !== undefined) restricted[key] = value;
    }
    if (isolatedHome) restricted.HOME = isolatedHome;
    return restricted;
}
