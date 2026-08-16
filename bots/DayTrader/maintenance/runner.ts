// DayTrader - Maintenance Worker Runner
//
// Periodically scans every open, development-owned technical issue
// (systemic_code, policy_gap, knowledge_gap, failure, upgrade - the exact
// five categories the development layer is responsible for) and repairs it
// end to end:
// - an approved deterministic recipe (see workerContract.ts) is always the
//   fast path when one matches;
// - otherwise the generic autonomous coding agent (autonomousWorkerRunner.ts)
//   is the default fallback - unknown technical defects are never deferred
//   merely because no recipe exists;
// - failed autonomous attempts are automatically retried later via a
//   bounded backoff (autonomousRetryPolicy.ts), never silently handed to a
//   human for a purely technical reason;
// - autonomous canary commits are deployed (cherry-picked into the live
//   checkout), observed, and promoted/rolled back by autonomousDeployment.ts.
//
// Only an explicit `requires_direction` outcome from the autonomous agent
// itself (missing credentials/external authorization, or an irreversible
// product/policy decision) ever re-routes an issue to a human.

import { getIssue, listIssues, listRetryReadyIssues, type IssueRecord } from '../lib/issueRegistry';
import { listMaintenanceWork } from '../lib/maintenanceStore';
import { findApprovedRecipeForIssue, getApprovedRecipe } from './workerContract';
import { promoteMaintenanceWork, runMaintenanceWork } from './isolatedWorkerRunner';
import {
    AUTONOMOUS_RECIPE_ID,
    DEVELOPMENT_ELIGIBLE_CATEGORIES,
    runAutonomousMaintenanceWork,
} from './autonomousWorkerRunner';
import {
    deployAutonomousMaintenanceWork,
    evaluateAutonomousCanaries,
} from './autonomousDeployment';
import { log } from '../lib/logger';
import { recordRuntimeHeartbeat } from '../lib/runtimeHealth';
import { captureStartupGeneration, isReloadRequested } from '../lib/deploymentReload';

const SCAN_INTERVAL_MS = 60_000;
let stopping = false;
// See development/runner.ts for why every long-running DayTrader process
// tracks its own startup generation against lib/deploymentReload.ts.
const startupGeneration = captureStartupGeneration();

/** Every open, development-owned issue eligible for automatic repair (recipe or autonomous), oldest-first inside each category. */
export function eligibleCandidates(limit = 20): IssueRecord[] {
    const candidates: IssueRecord[] = [];
    for (const category of DEVELOPMENT_ELIGIBLE_CATEGORIES) {
        candidates.push(
            ...listIssues({ category, ownerLayer: 'development', openOnly: true, limit }).filter(
                issue => issue.status === 'detected' || issue.status === 'triaged'
            )
        );
    }
    return candidates;
}

async function repairIssue(issue: IssueRecord): Promise<void> {
    const recipe = findApprovedRecipeForIssue(issue);
    if (recipe) {
        try {
            const work = await runMaintenanceWork(issue, recipe.id);
            if (work.status === 'canary' && recipe.autoPromote) {
                await promoteMaintenanceWork(work.id, 'approved deterministic recipe passed canary and deployment verification');
            }
            log('note', { msg: 'maintenance worker finished a recipe run', issueId: issue.id, recipeId: recipe.id, status: work.status });
        } catch (error) {
            log('development_error', { stage: 'maintenance_worker_recipe', issueId: issue.id, recipeId: recipe.id, error: String(error) });
        }
        return;
    }

    // No deterministic recipe matches - the generic autonomous coding agent
    // is the default fallback, never a reason to leave the issue unowned.
    try {
        const work = await runAutonomousMaintenanceWork(issue);
        if (work.status === 'canary') {
            await deployAutonomousMaintenanceWork(work.id);
        }
        log('note', { msg: 'maintenance worker finished an autonomous repair attempt', issueId: issue.id, status: work.status });
    } catch (error) {
        log('development_error', { stage: 'maintenance_worker_autonomous', issueId: issue.id, error: String(error) });
    }
}

async function scanOnce(): Promise<void> {
    // 1. Deterministic-recipe canaries explicitly approved for automatic
    //    promotion (unchanged fast path). Filtered at the SQL layer
    //    (excludeRecipeId, before LIMIT) so a high-volume run of
    //    autonomous-development canaries can never starve deterministic
    //    recipes out of this bounded page - see
    //    ListMaintenanceWorkFilter.excludeRecipeId in maintenanceStore.ts.
    for (const work of listMaintenanceWork({ status: 'canary', excludeRecipeId: AUTONOMOUS_RECIPE_ID, limit: 20 })) {
        const recipe = getApprovedRecipe(work.recipeId);
        if (!recipe?.autoPromote || !getIssue(work.issueId)) continue;
        try {
            await promoteMaintenanceWork(work.id, 'approved deterministic recipe passed canary and deployment verification');
        } catch (error) {
            log('development_error', { stage: 'maintenance_auto_promotion', workId: work.id, issueId: work.issueId, error: String(error) });
        }
    }

    // 2. Autonomous canaries not yet deployed: deploy them into the live
    //    checkout (still does not resolve the issue - see step 3). Filtered
    //    at the SQL layer (canaryDeploymentState: 'pending', before LIMIT)
    //    and ordered oldest-updated-first, so a large number of already-
    //    deployed canaries sitting in 'canary' status (repeatedly touched
    //    by step 3's bounded extensions) can never crowd genuinely
    //    not-yet-deployed canaries out of this bounded page - see
    //    ListMaintenanceWorkFilter.canaryDeploymentState in
    //    maintenanceStore.ts.
    for (const work of listMaintenanceWork({
        status: 'canary',
        recipeId: AUTONOMOUS_RECIPE_ID,
        canaryDeploymentState: 'pending',
        orderBy: 'updated_asc',
        limit: 20,
    })) {
        try {
            await deployAutonomousMaintenanceWork(work.id);
            if (isReloadRequested(startupGeneration)) return;
        } catch (error) {
            log('development_error', { stage: 'maintenance_autonomous_deploy', workId: work.id, issueId: work.issueId, error: String(error) });
        }
    }

    // 3. Evaluate every deployed autonomous canary: rollback on
    //    redetection/regression, promote/resolve after a healthy
    //    observation window, or extend boundedly if inconclusive.
    try {
        await evaluateAutonomousCanaries();
    } catch (error) {
        log('development_error', { stage: 'maintenance_autonomous_canary_evaluation', error: String(error) });
    }

    // 4. Development-owned issues whose bounded backoff window has
    //    elapsed: automatically reopened and retried, never left waiting
    //    on a human for a purely technical reason.
    for (const issue of listRetryReadyIssues()) {
        await repairIssue(issue);
        if (isReloadRequested(startupGeneration)) return;
    }

    // 5. Freshly detected/triaged development-owned technical issues
    //    across every eligible category (not just systemic_code).
    for (const issue of eligibleCandidates()) {
        await repairIssue(issue);
        if (isReloadRequested(startupGeneration)) return;
    }
}

async function main(): Promise<void> {
    log('note', { msg: 'maintenance worker started', scanIntervalMs: SCAN_INTERVAL_MS, startupGeneration });
    while (!stopping) {
        recordRuntimeHeartbeat('maintenance-worker', 'scan', startupGeneration);
        try {
            await scanOnce();
        } catch (error) {
            log('development_error', { stage: 'maintenance_worker_scan', error: String(error) });
        }
        // Every write from scanOnce() has already been persisted (issue and
        // maintenance_work lifecycle transitions are synchronous SQLite
        // transactions) by the time we reach this check, so exiting here
        // never loses in-flight lifecycle state.
        if (isReloadRequested(startupGeneration)) {
            log('note', { msg: 'newer deployment detected; maintenance worker restarting for fresh code', startupGeneration });
            break;
        }
        await Bun.sleep(SCAN_INTERVAL_MS);
    }
}

function stop(): void {
    stopping = true;
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// Guarded so this module can be imported (e.g. by tests exercising
// eligibleCandidates()) without starting the real scan loop or registering
// duplicate signal handlers.
if (import.meta.main) {
    await main();
}
