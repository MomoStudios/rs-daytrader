import { DevelopmentBrain } from '../lib/developmentBrain';
import {
    claimDevelopmentWork,
    completeDevelopmentWork,
    failDevelopmentWork,
} from '../lib/developmentStore';
import { buildGameTrace } from '../lib/gameTrace';
import { log } from '../lib/logger';
import { retrieveServerEvidence } from '../lib/serverKnowledge';
import { recordRuntimeHeartbeat } from '../lib/runtimeHealth';
import { captureStartupGeneration, isReloadRequested } from '../lib/deploymentReload';

const brain = new DevelopmentBrain();
let stopping = false;
// Captured once at startup: if the autonomous maintenance pipeline deploys
// or rolls back a commit while this process is running, its module graph
// is stale. Rather than reason about hot-reloading, this process finishes
// whatever it's doing and exits cleanly so the supervisor restarts it with
// freshly imported code (see lib/deploymentReload.ts).
const startupGeneration = captureStartupGeneration();

async function runReview(): Promise<void> {
    const work = claimDevelopmentWork();
    if (!work) return;
    const prompt = work.request?.prompt ?? null;
    try {
        const trace = buildGameTrace(4, 4_000);
        const research = await brain.researchPlan(trace, prompt);
        const evidence = await retrieveServerEvidence(research.queries);
        const review = await brain.review({ trace, prompt, research, evidence });
        const stored = completeDevelopmentWork({
            trigger: work.trigger,
            requestId: work.request?.id,
            prompt,
            traceWindow: trace.window,
            researchQueries: research.queries,
            evidenceSources: [...new Set(evidence.map(item => item.source))],
            review,
        });
        log('development_review', {
            reviewId: stored.id,
            trigger: work.trigger,
            model: brain.getModel(),
            summary: review.summary,
            health: review.health,
            findings: review.findings,
            publishedKnowledge: review.knowledgeUpdates.length,
            publishedWorkflows: review.workflowProposals.length,
            noActionReason: review.noActionReason,
        });
    } catch (error) {
        failDevelopmentWork(work.request?.id, error);
        log('development_error', {
            trigger: work.trigger,
            requestId: work.request?.id,
            error: String(error),
        });
    }
}

async function main(): Promise<void> {
    await brain.start();
    log('note', {
        msg: 'development agent started',
        model: brain.getModel(),
        reasoningEffort: 'medium',
        intervalMinutes: 30,
        startupGeneration,
    });
    while (!stopping) {
        recordRuntimeHeartbeat('development-reviewer', 'scan', startupGeneration);
        await runReview();
        // Checked only between iterations - never mid-review - so a review
        // already in flight always finishes and persists before this
        // process gives up its turn to the supervisor's restart.
        if (isReloadRequested(startupGeneration)) {
            log('note', { msg: 'newer deployment detected; development reviewer restarting for fresh code', startupGeneration });
            stopping = true;
            break;
        }
        await Bun.sleep(10_000);
    }
    await brain.stop();
    process.exit(0);
}

async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    await brain.stop();
    process.exit(0);
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

await main();
