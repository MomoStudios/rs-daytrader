// DayTrader - Protected Path Policy
//
// Most autonomous patches only ever need to pass the pinned verification
// gate (see pinnedGate.ts) plus the broad path/secret/size policy already
// enforced in autonomousWorkerRunner.ts. A small set of "protected" paths
// get one more layer: any patch touching them must also pass a
// deterministic prompt-injection scan and a quorum of independent,
// unanimous AutonomousPatchReviewer sessions (see
// lib/autonomousPatchReviewer.ts) before the deterministic host will ever
// commit or deploy it. Protected paths are, deliberately, exactly the
// files whose own content controls how much trust the autonomous pipeline
// places in itself:
// - `package.json` and every lockfile (a compromised "check"/"test" script
//   or a swapped dependency is exactly the kind of attack the pinned gate
//   was built to be immune to - protecting the files themselves is the
//   other half of that story);
// - the entire maintenance/ control-plane directory (worker, deployment,
//   permission handler, retry policy, pinned gate, recipe contract);
// - the supervisor process that restarts every other DayTrader process;
// - the handful of lib/ files that are just as load-bearing for autonomy
//   safety even though they live outside maintenance/ (the agent result
//   schema, the deployment-reload generation counter, the issue/
//   maintenance-work registry and its SQLite migrations, and the
//   finding -> issue bridge).
//
// This module is intentionally pure/dependency-free so the policy itself
// is trivially unit-testable and reusable from any caller without pulling
// in the Copilot SDK.

const PROTECTED_PATH_PATTERNS: RegExp[] = [
    /(^|\/)package\.json$/,
    /(^|\/)package-lock\.json$/,
    /(^|\/)bun\.lockb?$/,
    /(^|\/)yarn\.lock$/,
    /(^|\/)pnpm-lock\.ya?ml$/,
    // The entire autonomous worker/deployment/permission/recipe control
    // plane, so a *new* file added there is protected automatically -
    // never requires remembering to update this list.
    /(^|\/)bots\/DayTrader\/maintenance\//,
    // The supervisor that restarts every other DayTrader process.
    /(^|\/)bots\/DayTrader\/run-supervisor\.(ts|sh)$/,
    // Any lib/ file whose name itself starts with "autonomous" (the agent
    // result schema, the tool-enabled agent wrapper, the patch reviewer,
    // ...) - covers future additions the same way.
    /(^|\/)bots\/DayTrader\/lib\/autonomous[A-Za-z]*\.ts$/,
    // The handful of specific non-"autonomous"-named lib/ files that are
    // just as load-bearing for autonomy safety.
    /(^|\/)bots\/DayTrader\/lib\/(deploymentReload|issueRegistry|maintenanceStore|registryDb|developmentIssueBridge|registryMetrics)\.ts$/,
];

function normalize(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

/** True when `path` is a protected control-plane/dependency-manifest path. */
export function isProtectedPath(path: string): boolean {
    const normalized = normalize(path);
    return PROTECTED_PATH_PATTERNS.some(pattern => pattern.test(normalized));
}

/** True when any of `paths` is protected - the trigger for requiring an independent patch review. */
export function anyProtectedPathTouched(paths: string[]): boolean {
    return paths.some(isProtectedPath);
}

/** Every protected path within `paths`, for building a precise, reviewable list in logs/reasons. */
export function listProtectedPaths(paths: string[]): string[] {
    return paths.filter(isProtectedPath);
}
