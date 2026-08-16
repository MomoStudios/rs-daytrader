// DayTrader - Maintenance Worker Runner
//
// Periodically scans for open, systemic_code issues that have an approved,
// deterministically-matching repair recipe, and runs that recipe end-to-end
// (isolated worktree -> allowlisted commands -> mandatory tests -> canary
// commit). Recipes explicitly approved for automatic promotion are deployed
// only after target-path validation and post-deployment verification. Issues without a matching
// approved recipe are left alone entirely: they stay owned/deferred for a
// human or the development reviewer, never guessed at.

import { listIssues } from '../lib/issueRegistry';
import { getIssue } from '../lib/issueRegistry';
import { listMaintenanceWork } from '../lib/maintenanceStore';
import { findApprovedRecipeForIssue, getApprovedRecipe } from './workerContract';
import { promoteMaintenanceWork, runMaintenanceWork } from './isolatedWorkerRunner';
import { log } from '../lib/logger';
import { recordRuntimeHeartbeat } from '../lib/runtimeHealth';

const SCAN_INTERVAL_MS = 60_000;
let stopping = false;

async function scanOnce(): Promise<void> {
    for (const work of listMaintenanceWork({ status: 'canary', limit: 20 })) {
        const recipe = getApprovedRecipe(work.recipeId);
        if (!recipe?.autoPromote || !getIssue(work.issueId)) continue;
        try {
            await promoteMaintenanceWork(work.id, 'approved deterministic recipe passed canary and deployment verification');
        } catch (error) {
            log('development_error', {
                stage: 'maintenance_auto_promotion',
                workId: work.id,
                issueId: work.issueId,
                error: String(error),
            });
        }
    }

    const candidates = listIssues({ category: 'systemic_code', openOnly: true, limit: 20 }).filter(
        issue => issue.status === 'detected' || issue.status === 'triaged'
    );
    for (const issue of candidates) {
        const recipe = findApprovedRecipeForIssue(issue);
        if (!recipe) continue; // stays owned/deferred - no guessing.
        try {
            const work = await runMaintenanceWork(issue, recipe.id);
            if (work.status === 'canary' && recipe.autoPromote) {
                await promoteMaintenanceWork(
                    work.id,
                    'approved deterministic recipe passed canary and deployment verification'
                );
            }
            log('note', {
                msg: 'maintenance worker finished a recipe run',
                issueId: issue.id,
                recipeId: recipe.id,
                status: work.status,
            });
        } catch (error) {
            log('development_error', { stage: 'maintenance_worker', issueId: issue.id, recipeId: recipe.id, error: String(error) });
        }
    }
}

async function main(): Promise<void> {
    log('note', { msg: 'maintenance worker started', scanIntervalMs: SCAN_INTERVAL_MS });
    while (!stopping) {
        recordRuntimeHeartbeat('maintenance-worker', 'scan');
        try {
            await scanOnce();
        } catch (error) {
            log('development_error', { stage: 'maintenance_worker_scan', error: String(error) });
        }
        await Bun.sleep(SCAN_INTERVAL_MS);
    }
}

function stop(): void {
    stopping = true;
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await main();
