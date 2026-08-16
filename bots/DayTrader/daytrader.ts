// DayTrader - AI-supervised trading and progression bot
//
// Copilot provides contextual reasoning about conversation, market demand,
// progression, and the next reusable skill to run. It has no tools and returns
// strict JSON. This process validates that JSON and executes only allowlisted
// actions. Trade profitability and confirm-screen safety remain deterministic.

import { runScript } from '../../sdk/runner';
import {
    TRADE_REQUEST_CHAT_TYPE,
    type GameMessage,
    type TradeItem,
} from '../../sdk/types';
import { DayTraderBrain, type AiChatObservation, type AiWorldObservation } from './lib/aiBrain';
import type { AiDecision, ChatAction, StrategicAction } from './lib/aiDecision';
import { processChatBatch, type TradeOpportunity } from './lib/chatMonitor';
import { shouldAdvertise, craftAndRecordAdvertisement } from './lib/advertiser';
import { getSellableItemNames } from './lib/economy';
import {
    evaluateTradeOffer,
    minAskPriceGp,
    maxBidPriceGp,
    chooseCounterOfferItem,
    ESSENTIAL_TOOL_PATTERN,
} from './lib/tradeEvaluator';
import {
    getState as getPersistentState,
    isBlacklisted,
    noteTradeChatSeen,
    recordAd,
    recordTradeOutcome,
} from './lib/stateStore';
import { estimateOfferValue, getValue } from './lib/priceBook';
import { log } from './lib/logger';
import { assessMessage } from './lib/scamGuard';
import { normalizeOutgoingMessage, validateConversationalReply } from './lib/chatSafety';
import { executeFallbackAction, executeStrategicAction, type SkillResult } from './lib/skillLibrary';
import {
    loadStrategy,
    recordActionResult,
    recordDecision,
    recordGoalCompletion,
} from './lib/strategyStore';
import { updateCollectionStatus } from './lib/collectionPortfolio';
import { shouldRequestAiPlan } from './lib/planningPolicy';
import { OperatorCoordinator } from './lib/operatorCoordinator';
import {
    operatorRequestFromStrategist,
    type OperatorPlanningRequest,
    type OperatorWorldObservation,
} from './lib/operatorBrain';
import { loadOperatorState, resetOperatorWorkflow } from './lib/operatorStore';
import { listReusableWorkflows } from './lib/workflowStore';
import { retrieveExecutionKnowledge } from './lib/executionKnowledge';
import {
    activeHumanGuidance,
    markHumanGuidanceApplied,
    pendingHumanGuidance,
    resolveHumanGuidance,
} from './lib/humanGuidance';
import type { OperatorDecision } from './lib/operatorSchema';
import {
    enqueueUniqueName,
    preparedPlanIsStale,
} from './lib/runtimeScheduler';
import { activeDevelopmentKnowledge } from './lib/developmentStore';
import { updateAssetMemory } from './lib/assetMemory';
import {
    evaluateGoalCompletion,
    guidanceIdsSatisfiedByGoal,
} from './lib/goalCompletion';
import { compileTradeHandoff } from './lib/tradeHandoff';
import {
    inventoryDelta,
    summarizeInventory,
} from './lib/tradeReconciliation';

const TRADE_SESSION_TIMEOUT_MS = 25_000;
const REPITCH_COOLDOWN_MS = 2 * 60 * 1000;
const DISCUSSION_COOLDOWN_MS = 2 * 60 * 1000;
const PLAN_INTERVAL_MS = 2 * 60 * 1000;
const AI_RETRY_BACKOFF_MS = 30_000;
const CHAT_MEMORY_LIMIT = 60;

interface KnownDeal {
    kind: 'sell' | 'buy';
    item: string;
    priceGp: number;
    at: number;
}

const knownDeals = new Map<string, KnownDeal>();
const lastPitchAt = new Map<string, number>();
const recentChat: AiChatObservation[] = [];
let lastAiAttemptAt = 0;
let lastOperatorAttemptAt = 0;
let lastDiscussionAt = 0;
let pendingChatForAi = false;
let chatGeneration = 0;
// Goals persist across restarts; concrete actions do not, because location,
// inventory, and nearby conversation may have changed while offline.
let activeAction: StrategicAction | null = null;
let lastCharacterTraceAt = 0;
let lastCharacterTraceSignature = '';

await runScript(async ({ bot, sdk }) => {
    await bot.skipTutorial();

    const brain = new DayTraderBrain();
    const operator = new OperatorCoordinator();
    let brainAvailable = false;
    let operatorAvailable = false;
    try {
        await brain.start();
        brainAvailable = true;
        log('note', { msg: 'AI strategist started', model: brain.getModel(), toolsEnabled: false });
    } catch (error) {
        log('ai_error', { stage: 'startup', error: String(error) });
    }
    try {
        await operator.start();
        operatorAvailable = true;
        const existingDecision = loadStrategy().lastDecision;
        if (existingDecision) operator.setPlanningContext(buildOperatorRequest(existingDecision));
    } catch (error) {
        log('ai_error', { stage: 'operator_startup', error: String(error) });
    }

    log('note', { msg: 'DayTrader hybrid AI/automation loop starting' });
    reconcileCompletedGoalHistory();
    // A fresh SDK connection may expose retained chat history as "new".
    // Establish a cursor without replaying old negotiations after restarts.
    sdk.getNewChat();
    const fallbackOpportunities: TradeOpportunity[] = [];
    const incomingTradeRequests: string[] = [];
    let planningPromise: Promise<void> | null = null;
    type PreparedPlan = {
        decision: AiDecision;
        operatorDecision: OperatorDecision | null;
        operatorRequest: OperatorPlanningRequest | null;
        guidanceIds: string[];
        chatGeneration: number;
        strategistChanged: boolean;
    };
    const planningState: { preparedPlan: PreparedPlan | null } = {
        preparedPlan: null,
    };

    const unsubscribeChatWatcher = sdk.onStateUpdate(() => ingestNewChat());

    while (true) {
        ingestNewChat();
        maybeLogCharacterTrace();
        await clearStaleTradeInterface();

        if (!brainAvailable && Date.now() - lastAiAttemptAt >= AI_RETRY_BACKOFF_MS) {
            lastAiAttemptAt = Date.now();
            try {
                await brain.start();
                brainAvailable = true;
                log('note', { msg: 'AI strategist recovered', model: brain.getModel(), toolsEnabled: false });
            } catch (error) {
                log('ai_error', { stage: 'restart', error: String(error) });
            }
            if (
                !operatorAvailable &&
                Date.now() - lastOperatorAttemptAt >= AI_RETRY_BACKOFF_MS
            ) {
                lastOperatorAttemptAt = Date.now();
                try {
                    await operator.start();
                    operatorAvailable = true;
                    const existingDecision = loadStrategy().lastDecision;
                    if (existingDecision) {
                        operator.setPlanningContext(buildOperatorRequest(existingDecision));
                    }
                    log('note', {
                        msg: 'operator AI recovered',
                        model: operator.getModel(),
                        toolsEnabled: false,
                    });
                } catch (error) {
                    log('ai_error', { stage: 'operator_restart', error: String(error) });
                }
            }
        }

        startPlanningIfDue();

        const requester = incomingTradeRequests.shift();
        if (requester) {
            await finishCurrentFight();
            await handleIncomingTradeRequest(requester);
            pendingChatForAi = true;
            chatGeneration += 1;
            continue;
        }

        if (planningState.preparedPlan) {
            const candidate = planningState.preparedPlan;
            const currentGuidance = pendingHumanGuidance();
            if (
                preparedPlanIsStale({
                    planChatGeneration: candidate.chatGeneration,
                    currentChatGeneration: chatGeneration,
                    planGuidanceIds: candidate.guidanceIds,
                    pendingGuidanceIds: currentGuidance.map(instruction => instruction.id),
                })
            ) {
                // Inputs changed while the AIs were thinking. Drop the stale
                // answer without side effects and immediately plan again.
                planningState.preparedPlan = null;
                continue;
            }
            await finishCurrentFight();
            const plan = candidate;
            planningState.preparedPlan = null;
            await installPreparedPlan(plan);
            continue;
        }

        if (!brainAvailable && fallbackOpportunities.length > 0) {
            const opportunity = fallbackOpportunities.shift();
            if (opportunity) await respondDeterministically(opportunity);
        }

        if (shouldAdvertise()) {
            const message = craftAndRecordAdvertisement({
                sellableItems: getSellableItemNames({ bot, sdk }),
            });
            await sdk.say(message);
            continue;
        }

        if (operatorAvailable && loadOperatorState().pendingEscalation) {
            // Planning runs in the background; keep the action lane quiet until
            // the strategist answers the operator escalation.
            await sdk.waitForTicks(1).catch(() => undefined);
            continue;
        }

        let result: SkillResult;
        let operatorResult: SkillResult | null = null;
        if (operatorAvailable) {
            try {
                operatorResult = await operator.executeOne({ bot, sdk });
            } catch (error) {
                log('ai_error', { stage: 'operator_execute', error: String(error) });
            }
        }
        const usedOperator = operatorResult !== null;
        if (operatorResult) {
            result = operatorResult;
        } else if (planningPromise) {
            await sdk.waitForTicks(1).catch(() => undefined);
            continue;
        } else if (activeAction) {
            try {
                result = await executeStrategicAction({ bot, sdk }, activeAction);
            } catch (error) {
                result = {
                    success: false,
                    action: JSON.stringify(activeAction),
                    message: `Skill execution threw: ${error}`,
                };
                log('error', { stage: 'skill_execution', action: activeAction, error: String(error) });
            }
        } else {
            result = await executeFallbackAction({ bot, sdk });
        }
        recordActionResult(result.action, result.success, result.message);
        const postActionState = sdk.getState();
        if (postActionState) updateAssetMemory(postActionState);
        if (!result.success) await sdk.waitForTicks(1).catch(() => undefined);
        if (
            usedOperator &&
            !loadOperatorState().workflow &&
            !loadOperatorState().pendingEscalation
        ) {
            // A workflow just completed. Replan immediately against the new
            // holdings/levels instead of leaving the old strategic goal on
            // screen until the periodic interval.
            pendingChatForAi = true;
            lastAiAttemptAt = 0;
            recordCurrentGoalCompletionIfSatisfied();
        }

        // A failed skill usually means the goal needs a prerequisite or a
        // different location. Replan promptly rather than repeating it.
        if (!usedOperator && !result.success) {
            activeAction = null;
        } else if (!usedOperator && activeAction?.type !== 'train' && activeAction?.type !== 'sell_excess') {
            // Travel, pickup, and waiting are one-shot actions. Selling may
            // repeat one bounded inventory item per loop until stock is clear.
            activeAction = null;
            lastAiAttemptAt = Date.now() - AI_RETRY_BACKOFF_MS;
        }
    }

    function ingestNewChat(): void {
        const messages = sdk.getNewChat({
            types: [0, 1, 2, 3, TRADE_REQUEST_CHAT_TYPE, 6, 7],
            includeSelf: true,
        });
        if (messages.length === 0) return;
        const tradeRequests = messages.filter(
            message =>
                message.type === TRADE_REQUEST_CHAT_TYPE &&
                /wishes to trade/i.test(message.text) &&
                message.sender
        );
        for (const request of tradeRequests) {
            enqueueUniqueName(incomingTradeRequests, request.sender);
        }
        if (tradeRequests.length > 0) noteTradeChatSeen();
        const ordinaryMessages = messages.filter(
            message => message.type !== TRADE_REQUEST_CHAT_TYPE
        );
        const external = ordinaryMessages.filter(
            message => !message.fromSelf && message.sender && message.text
        );
        fallbackOpportunities.push(...processChatBatch(ordinaryMessages));
        appendChatObservations(external);
        if (external.length > 0 || tradeRequests.length > 0) {
            pendingChatForAi = true;
            chatGeneration += 1;
        }
    }

    function startPlanningIfDue(): void {
        if (planningPromise || planningState.preparedPlan) return;
        const strategy = loadStrategy();
        const operatorRuntime = loadOperatorState();
        const guidance = pendingHumanGuidance();
        const strategicPlanningDue = shouldRequestAiPlan({
            pendingChatForAi:
                pendingChatForAi ||
                guidance.length > 0 ||
                !!operatorRuntime.pendingEscalation,
            hasActiveAction: !!activeAction || !!operatorRuntime.workflow,
            now: Date.now(),
            lastPlannedAt: strategy.lastPlannedAt,
            planIntervalMs: PLAN_INTERVAL_MS,
        });
        const auditDue =
            operatorAvailable &&
            !!strategy.lastDecision &&
            operator.needsAudit();
        if ((!strategicPlanningDue && !auditDue) || Date.now() - lastAiAttemptAt < AI_RETRY_BACKOFF_MS) {
            return;
        }

        lastAiAttemptAt = Date.now();
        const generation = chatGeneration;
        planningPromise = (async () => {
            if (strategicPlanningDue && brainAvailable) {
                const observation = buildWorldObservation();
                const guidanceIds = observation.humanGuidance.map(instruction => instruction.id);
                const decision = await brain.decide(observation);
                const currentWorld = sdk.getState();
                if (!currentWorld) throw new Error('Cannot validate strategic goal without world state');
                const completion = evaluateGoalCompletion(
                    decision.goal,
                    updateAssetMemory(currentWorld),
                    currentWorld.skills
                );
                if (completion.complete) {
                    recordGoalCompletion(decision.goal, completion.evidence);
                    const resolvedGuidanceIds = guidanceIdsSatisfiedByGoal(
                        observation.humanGuidance,
                        decision.goal
                    );
                    resolveHumanGuidance(
                        resolvedGuidanceIds,
                        `Completed: ${completion.evidence}`
                    );
                    log('goal_completed', {
                        goal: decision.goal,
                        evidence: completion.evidence,
                        resolvedGuidanceIds,
                    });
                    pendingChatForAi = true;
                    lastAiAttemptAt = 0;
                    return;
                }
                let operatorDecision: OperatorDecision | null = null;
                let operatorRequest: OperatorPlanningRequest | null = null;
                if (operatorAvailable) {
                    try {
                        operatorRequest = buildOperatorRequest(decision);
                        operatorDecision =
                            compileTradeHandoff(
                                decision,
                                operatorRequest.assetMemory,
                                {
                                    x: operatorRequest.world.player.position.x,
                                    z: operatorRequest.world.player.position.z,
                                }
                            ) ??
                            (await operator.preparePlan(operatorRequest));
                    } catch (error) {
                        log('ai_error', { stage: 'operator_plan_prepare', error: String(error) });
                        if (isClosedConnectionError(error)) {
                            operatorAvailable = false;
                            await operator.stop();
                        }
                    }
                }
                planningState.preparedPlan = {
                    decision,
                    operatorDecision,
                    operatorRequest,
                    guidanceIds,
                    chatGeneration: generation,
                    strategistChanged: true,
                };
                return;
            }

            if (auditDue && strategy.lastDecision && operatorAvailable) {
                const decision = strategy.lastDecision;
                const operatorRequest = buildOperatorRequest(decision);
                const operatorDecision = await operator.preparePlan(operatorRequest);
                planningState.preparedPlan = {
                    decision,
                    operatorDecision,
                    operatorRequest,
                    guidanceIds: [],
                    chatGeneration: generation,
                    strategistChanged: false,
                };
            }
        })()
            .catch(async error => {
                log('ai_error', { stage: 'background_planning', error: String(error) });
                if (isClosedConnectionError(error)) {
                    brainAvailable = false;
                    operatorAvailable = false;
                    await brain.stop();
                    await operator.stop();
                }
            })
            .finally(() => {
                planningPromise = null;
            });
    }

    async function installPreparedPlan(plan: PreparedPlan): Promise<void> {
        if (plan.strategistChanged) {
            recordDecision(plan.decision);
            markHumanGuidanceApplied(plan.guidanceIds, plan.decision.summary);
            activeAction = plan.decision.nextAction;
            pendingChatForAi = chatGeneration > plan.chatGeneration;
            log('ai_plan', {
                model: brain.getModel(),
                summary: plan.decision.summary,
                marketSignals: plan.decision.marketSignals,
                goal: plan.decision.goal,
                nextAction: plan.decision.nextAction,
                chatActions: plan.decision.chatActions,
            });
            await executeChatActions(plan.decision);
        }

        if (operatorAvailable && plan.operatorDecision) {
            resetOperatorWorkflow();
            operator.installPreparedPlan(
                plan.operatorDecision,
                { bot, sdk },
                plan.operatorRequest ?? undefined
            );
            activeAction = null;
        } else if (plan.strategistChanged) {
            resetOperatorWorkflow();
        }
    }

    async function finishCurrentFight(): Promise<void> {
        if (!sdk.getState()?.player?.combat.inCombat) return;
        await sdk
            .waitForCondition(
                state => !state.player?.combat.inCombat || state.player.isDead,
                60_000
            )
            .catch(() => undefined);
    }

    function isClosedConnectionError(error: unknown): boolean {
        return /connection is closed|session.*closed|not connected/i.test(String(error));
    }

    async function clearStaleTradeInterface(): Promise<void> {
        const state = sdk.getState();
        if (!state) return;
        const tradeInterface =
            state.interface.isOpen &&
            (state.interface.interfaceId === 3323 ||
                state.interface.interfaceId === 3443);
        if (!tradeInterface || state.trade?.isOpen) return;
        const cleared = await bot.declineTrade();
        log('note', {
            msg: 'cleared stale trade interface',
            interfaceId: state.interface.interfaceId,
            success: cleared.success,
            message: cleared.message,
        });
    }

    function recordCurrentGoalCompletionIfSatisfied(): void {
        const world = sdk.getState();
        const goal = loadStrategy().currentGoal;
        if (!world || !goal) return;
        const completion = evaluateGoalCompletion(
            goal,
            updateAssetMemory(world),
            world.skills
        );
        if (!completion.complete) return;
        recordGoalCompletion(goal, completion.evidence);
        const resolvedGuidanceIds = guidanceIdsSatisfiedByGoal(
            activeHumanGuidance(),
            goal
        );
        resolveHumanGuidance(
            resolvedGuidanceIds,
            `Completed: ${completion.evidence}`
        );
        log('goal_completed', {
            goal,
            evidence: completion.evidence,
            resolvedGuidanceIds,
        });
    }

    function reconcileCompletedGoalHistory(): void {
        const world = sdk.getState();
        if (!world) return;
        const assets = updateAssetMemory(world);
        for (const entry of loadStrategy().goalHistory.slice(-30)) {
            const completion = evaluateGoalCompletion(entry.goal, assets, world.skills);
            if (!completion.complete) continue;
            recordGoalCompletion(entry.goal, completion.evidence);
            const resolvedGuidanceIds = guidanceIdsSatisfiedByGoal(
                activeHumanGuidance(),
                entry.goal
            );
            resolveHumanGuidance(
                resolvedGuidanceIds,
                `Completed: ${completion.evidence}`
            );
        }
    }

    function appendChatObservations(messages: GameMessage[]): void {
        for (const message of messages) {
            const assessment = assessMessage(message.text);
            recentChat.push({
                sender: message.sender,
                // High-risk text is not needed for useful market reasoning.
                // Preserve its existence and signals without placing the
                // actual injection payload in the model context.
                text: assessment.highRisk ? '[withheld: high-risk message]' : message.text,
                tick: message.tick,
                directMention: /\bday\s*trader\b|\bdaytrader\b/i.test(message.text),
                scamSignals: assessment.signals.map(signal => signal.category),
                highRisk: assessment.highRisk,
            });
        }
        if (recentChat.length > CHAT_MEMORY_LIMIT) {
            recentChat.splice(0, recentChat.length - CHAT_MEMORY_LIMIT);
        }
    }

    function buildWorldObservation(): AiWorldObservation {
        const world = sdk.getState();
        if (!world?.player) throw new Error('Cannot plan without a live player state');
        const persistent = getPersistentState();
        const inventory = world.inventory.map(item => ({
            name: item.name,
            count: item.count,
            unitValueGp: getValue(item.name),
        }));
        const inventoryBookValueGp = inventory.reduce(
            (total, item) => total + (item.unitValueGp ?? 0) * item.count,
            0
        );
        return {
            now: Date.now(),
            player: {
                name: world.player.name,
                position: {
                    x: world.player.worldX,
                    z: world.player.worldZ,
                    level: world.player.level,
                },
                combatLevel: world.player.combatLevel,
                hp: world.player.hp,
                maxHp: world.player.maxHp,
            },
            skills: world.skills.map(skill => ({
                name: skill.name,
                level: skill.baseLevel,
                experience: skill.experience,
            })),
            inventory,
            nearbyPlayers: world.nearbyPlayers.slice(0, 15).map(player => player.name),
            nearbyNpcs: [...new Set(world.nearbyNpcs.slice(0, 30).map(npc => npc.name))],
            nearbyObjects: world.nearbyLocs.slice(0, 30).map(location => ({
                name: location.name,
                options: location.optionsWithIndex.map(option => option.text),
            })),
            wealth: {
                coins: world.inventory.find(item => /^coins$/i.test(item.name))?.count ?? 0,
                inventoryBookValueGp,
                completedTrades: persistent.tradesCompleted,
                estimatedTradeProfitGp: persistent.estimatedNetProfitGp,
            },
            currentStrategy: {
                currentGoal: loadStrategy().currentGoal,
                goalHistory: loadStrategy().goalHistory.slice(-20),
                marketMemory: [...loadStrategy().marketMemory]
                    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
                    .slice(0, 30),
                completedGoals: loadStrategy().completedGoals.slice(-30),
                materialReservations: loadStrategy().materialReservations,
                activeHumanGuidance: activeHumanGuidance(),
            },
            operatorStatus: {
                workflow: loadOperatorState().workflow?.name ?? null,
                stepIndex: loadOperatorState().stepIndex,
                pendingEscalation: loadOperatorState().pendingEscalation,
                recentEvidence: loadOperatorState().recentEvidence,
                lastFailure: loadOperatorState().lastFailure,
            },
            collectionPortfolio: updateCollectionStatus(world.inventory),
            recentActionResults: loadStrategy().recentActionResults.slice(-10),
            recentChat: [...recentChat],
            humanGuidance: activeHumanGuidance(),
            developmentKnowledge: activeDevelopmentKnowledge('strategist'),
            assetMemory: updateAssetMemory(world),
            tradeChatSilentForMs: Date.now() - persistent.lastTradeChatTime,
            advertisementDue: shouldAdvertise(),
        };
    }

    function buildOperatorWorldObservation(): OperatorWorldObservation {
        const world = sdk.getState();
        if (!world?.player) throw new Error('Cannot build operator observation without player state');
        return {
            now: Date.now(),
            stateAgeMs: sdk.getStateAge(),
            player: {
                position: { x: world.player.worldX, z: world.player.worldZ, level: world.player.level },
                combatLevel: world.player.combatLevel,
                hp: world.player.hp,
                maxHp: world.player.maxHp,
                runEnergy: world.player.runEnergy,
                inCombat: world.player.combat.inCombat,
            },
            skills: world.skills.map(skill => ({
                name: skill.name,
                level: skill.baseLevel,
                experience: skill.experience,
            })),
            inventory: world.inventory.map(item => ({ name: item.name, count: item.count })),
            equipment: world.equipment.map(item => ({ name: item.name, count: item.count })),
            nearbyNpcs: world.nearbyNpcs.slice(0, 40).map(npc => ({
                name: npc.name,
                x: npc.x,
                z: npc.z,
                distance: npc.distance,
                options: npc.optionsWithIndex.map(option => option.text),
            })),
            nearbyObjects: world.nearbyLocs.slice(0, 60).map(location => ({
                name: location.name,
                x: location.x,
                z: location.z,
                level: location.level,
                distance: location.distance,
                options: location.optionsWithIndex.map(option => option.text),
            })),
            groundItems: world.groundItems.slice(0, 30).map(item => ({
                name: item.name,
                count: item.count,
                x: item.x,
                z: item.z,
                distance: item.distance,
            })),
            nearbyPlayerCount: world.nearbyPlayers.length,
            dialog: {
                open: world.dialog.isOpen,
                text: world.dialog.text,
                options: world.dialog.options.map(option => option.text),
            },
            interface: {
                open: world.interface.isOpen,
                id: world.interface.interfaceId,
                options: world.interface.options.map(option => option.text),
            },
            bank: {
                open: world.bank.isOpen,
                items: world.bank.items.slice(0, 100).map(item => ({ name: item.name, count: item.count })),
            },
            shop: {
                open: world.shop.isOpen,
                title: world.shop.title,
                items: world.shop.shopItems.slice(0, 100).map(item => ({
                    name: item.name,
                    count: item.count,
                    price: item.buyPrice,
                })),
            },
            combatStyle: world.combatStyle
                ? {
                      currentStyle: world.combatStyle.currentStyle,
                      weaponName: world.combatStyle.weaponName,
                      styles: world.combatStyle.styles.map(style => ({
                          index: style.index,
                          name: style.name,
                          trainsSkills: style.trainsSkills,
                      })),
                  }
                : null,
            collectionPortfolio: updateCollectionStatus(world.inventory),
        };
    }

    function buildOperatorRequest(decision: AiDecision): OperatorPlanningRequest {
        const request = operatorRequestFromStrategist(
            decision,
            buildOperatorWorldObservation(),
            listReusableWorkflows().slice(0, 20)
        );
        request.executionKnowledge = retrieveExecutionKnowledge(decision);
        request.developmentKnowledge = activeDevelopmentKnowledge('operator');
        const world = sdk.getState();
        if (!world) throw new Error('Cannot build operator request without world state');
        request.assetMemory = updateAssetMemory(world);
        request.materialReservations = decision.reservations ?? [];
        return request;
    }

    function maybeLogCharacterTrace(): void {
        const state = sdk.getState();
        if (!state?.player) return;
        if (!state.inGame || (state.player.worldX === 0 && state.player.worldZ === 0)) {
            return;
        }
        const combatTarget =
            state.player.combat.inCombat && state.player.combat.targetType === 'npc'
                ? state.nearbyNpcs.find(npc => npc.index === state.player?.combat.targetIndex)?.name ?? null
                : null;
        const signature = JSON.stringify({
            position: [state.player.worldX, state.player.worldZ, state.player.level],
            skills: state.skills.map(skill => [skill.name, skill.baseLevel]),
            equipment: state.equipment.map(item => [item.name, item.count]),
            inventory: state.inventory.map(item => [item.name, item.count]),
            combatTarget,
        });
        if (
            signature === lastCharacterTraceSignature &&
            Date.now() - lastCharacterTraceAt < 2 * 60 * 1000
        ) {
            return;
        }
        lastCharacterTraceAt = Date.now();
        lastCharacterTraceSignature = signature;
        log('character_trace', {
            player: {
                position: {
                    x: state.player.worldX,
                    z: state.player.worldZ,
                    level: state.player.level,
                },
                hp: state.player.hp,
                maxHp: state.player.maxHp,
                combatLevel: state.player.combatLevel,
            },
            skills: state.skills.map(skill => ({
                name: skill.name,
                level: skill.baseLevel,
                xp: skill.experience,
            })),
            inventory: state.inventory.map(item => ({ name: item.name, count: item.count })),
            equipment: state.equipment.map(item => ({ name: item.name, count: item.count })),
            combat: {
                inCombat: state.player.combat.inCombat,
                target: combatTarget,
                style: state.combatStyle?.styles.find(
                    style => style.index === state.combatStyle?.currentStyle
                )?.name,
            },
            ui: {
                dialogOpen: state.dialog.isOpen,
                interfaceOpen: state.interface.isOpen,
                interfaceId: state.interface.interfaceId,
                modalOpen: state.modalOpen,
                modalInterface: state.modalInterface,
                tradeOpen: state.trade?.isOpen ?? false,
            },
        });
    }

    async function executeChatActions(decision: AiDecision): Promise<void> {
        for (const action of decision.chatActions) {
            try {
                await executeChatAction(action);
            } catch (error) {
                log('ai_error', { stage: 'chat_action', action, error: String(error) });
            }
        }
    }

    async function executeChatAction(action: ChatAction): Promise<void> {
        if (action.type === 'discussion') {
            if (Date.now() - lastDiscussionAt < DISCUSSION_COOLDOWN_MS) {
                log('note', { msg: 'rejected AI discussion during cooldown', action });
                return;
            }
            const message = validateConversationalReply(action.message);
            await sdk.say(message);
            lastDiscussionAt = Date.now();
            recordAd(message, 'ai_discussion');
            log('ad_sent', { message, style: 'ai_discussion', rationale: action.rationale });
            return;
        }

        if (action.type === 'broadcast') {
            if (!shouldAdvertise()) {
                log('note', { msg: 'rejected premature AI broadcast', action });
                return;
            }
            const sellableItems = getSellableItemNames({ bot, sdk });
            // Do not let prose generation hallucinate owned stock or prices.
            // Sale ads use actual inventory and deterministic minimum prices;
            // open-ended market conversation can retain the AI's wording.
            const message = /\b(sell|selling|for sale)\b/i.test(action.message)
                ? buildInventoryBackedSaleAd(sellableItems)
                : normalizeOutgoingMessage(action.message);
            if (!message) {
                log('note', { msg: 'rejected AI sale broadcast: no sellable inventory', action });
                return;
            }
            await sdk.say(message);
            recordAd(message, 'ai');
            log('ad_sent', { message, style: 'ai', rationale: action.rationale });
            return;
        }

        const observedSender = recentChat.find(
            observation => observation.sender.toLowerCase() === action.recipient.toLowerCase()
        )?.sender;
        if (!observedSender || isBlacklisted(observedSender)) {
            log('note', { msg: 'rejected AI chat action for unknown/blacklisted recipient', action });
            return;
        }
        const lastPitch = lastPitchAt.get(observedSender) ?? 0;
        if (Date.now() - lastPitch < REPITCH_COOLDOWN_MS) return;

        if (action.type === 'reply') {
            const message = validateConversationalReply(action.message);
            await sdk.say(`@${observedSender} ${message}`);
            lastPitchAt.set(observedSender, Date.now());
            return;
        }

        if (action.type === 'offer_sell') {
            const inventoryItem = sdk.findInventoryItem(action.item);
            if (!inventoryItem) {
                log('note', { msg: 'rejected AI sale offer: item not owned', action });
                return;
            }
            if (ESSENTIAL_TOOL_PATTERN.test(inventoryItem.name)) {
                log('note', { msg: 'rejected AI sale offer: essential progression tool', action });
                return;
            }
            const minimum = minAskPriceGp(inventoryItem.name);
            if (minimum === null) {
                log('note', { msg: 'rejected AI sale offer: item cannot be priced', action });
                return;
            }
            const safePrice = Math.max(minimum, action.priceGp);
            knownDeals.set(observedSender, {
                kind: 'sell',
                item: inventoryItem.name,
                priceGp: safePrice,
                at: Date.now(),
            });
            await sdk.say(`@${observedSender} I can sell ${inventoryItem.name} for ${safePrice}gp; trade me.`);
            lastPitchAt.set(observedSender, Date.now());
            return;
        }

        const maximum = maxBidPriceGp(action.item);
        const coins = sdk.findInventoryItem(/^coins$/i)?.count ?? 0;
        if (maximum === null || coins <= 0) {
            log('note', { msg: 'rejected AI buy offer: no safe price or available coins', action });
            return;
        }
        const safePrice = Math.min(maximum, action.priceGp, coins);
        if (safePrice <= 0) return;
        knownDeals.set(observedSender, {
            kind: 'buy',
            item: action.item,
            priceGp: safePrice,
            at: Date.now(),
        });
        await sdk.say(`@${observedSender} I can pay ${safePrice}gp for ${action.item}; trade me.`);
        lastPitchAt.set(observedSender, Date.now());
    }

    function buildInventoryBackedSaleAd(items: string[]): string | null {
        const item = items[0];
        if (!item) return null;
        const minimum = minAskPriceGp(item);
        if (minimum === null) return `Selling ${item}; message DayTrader with an offer.`;
        return `Selling ${item} from ${minimum}gp each; message DayTrader if interested.`;
    }

    async function respondDeterministically(opportunity: TradeOpportunity): Promise<void> {
        if (isBlacklisted(opportunity.sender)) return;
        const lastPitch = lastPitchAt.get(opportunity.sender) ?? 0;
        if (Date.now() - lastPitch < REPITCH_COOLDOWN_MS) return;

        if (opportunity.intent === 'buying') {
            for (const guess of opportunity.itemGuesses) {
                const inventoryItem = sdk.findInventoryItem(guess);
                if (!inventoryItem) continue;
                if (ESSENTIAL_TOOL_PATTERN.test(inventoryItem.name)) continue;
                const ask = minAskPriceGp(inventoryItem.name);
                if (ask === null || (opportunity.priceGp !== null && opportunity.priceGp < ask)) continue;
                knownDeals.set(opportunity.sender, {
                    kind: 'sell',
                    item: inventoryItem.name,
                    priceGp: ask,
                    at: Date.now(),
                });
                lastPitchAt.set(opportunity.sender, Date.now());
                await sdk.say(`@${opportunity.sender} I've got ${inventoryItem.name} for ${ask}gp; trade me.`);
                return;
            }
        }

        if (opportunity.intent === 'selling') {
            for (const guess of opportunity.itemGuesses) {
                const bid = maxBidPriceGp(guess);
                if (bid === null || (opportunity.priceGp !== null && opportunity.priceGp > bid)) continue;
                knownDeals.set(opportunity.sender, {
                    kind: 'buy',
                    item: guess,
                    priceGp: bid,
                    at: Date.now(),
                });
                lastPitchAt.set(opportunity.sender, Date.now());
                await sdk.say(`@${opportunity.sender} I can pay ${bid}gp for ${guess}; trade me.`);
                return;
            }
        }
    }

    async function handleIncomingTradeRequest(requester: string): Promise<void> {
        if (isBlacklisted(requester)) {
            log('note', { msg: 'ignoring trade request from blacklisted sender', requester });
            return;
        }

        const deal = knownDeals.get(requester);
        const dealFresh = deal && Date.now() - deal.at < 10 * 60 * 1000;

        if (dealFresh && deal.kind === 'sell' && sdk.findInventoryItem(deal.item)) {
            knownDeals.delete(requester);
            const result = await bot.trade(requester, {
                give: [{ item: deal.item, amount: 1 }],
                want: [{ item: 'coins', amount: deal.priceGp }],
                timeout: TRADE_SESSION_TIMEOUT_MS,
            });
            finishTrade(requester, result.gave, result.received, result.success, result.message);
            return;
        }

        const availableCoins = sdk.findInventoryItem(/^coins$/i)?.count ?? 0;
        if (dealFresh && deal.kind === 'buy' && availableCoins >= deal.priceGp) {
            knownDeals.delete(requester);
            const result = await bot.trade(requester, {
                give: [{ item: 'coins', amount: deal.priceGp }],
                want: [{ item: deal.item, amount: 1 }],
                timeout: TRADE_SESSION_TIMEOUT_MS,
            });
            finishTrade(requester, result.gave, result.received, result.success, result.message);
            return;
        }
        if (dealFresh && deal.kind === 'buy' && availableCoins < deal.priceGp) {
            knownDeals.delete(requester);
            log('note', {
                msg: 'discarded prearranged buy: insufficient coins',
                requester,
                required: deal.priceGp,
                available: availableCoins,
            });
        }

        await handleUnsolicitedTrade(requester);
    }

    async function handleUnsolicitedTrade(requester: string): Promise<void> {
        const inventoryBefore = summarizeInventory(sdk.getInventory());
        const opened = await bot.tradeWith(requester, TRADE_SESSION_TIMEOUT_MS);
        if (!opened.success) {
            log('trade_result', { requester, success: false, message: opened.message });
            return;
        }

        const deadline = Date.now() + TRADE_SESSION_TIMEOUT_MS;
        let offeredCounter = false;
        let lastLoggedKey = '';

        while (Date.now() < deadline) {
            const trade = sdk.getTradeState();
            if (!trade.isOpen) break;

            if (!offeredCounter && trade.theirOffer.length > 0) {
                const theirValue = estimateOfferValue(trade.theirOffer).total;
                const counter = chooseCounterOfferItem(sdk.getInventory(), theirValue);
                if (counter) {
                    await bot.offerTradeItems([{ item: counter.name, amount: counter.count }]);
                }
                offeredCounter = true;
            }

            const current = sdk.getTradeState();
            const decision = evaluateTradeOffer(requester, current.myOffer, current.theirOffer);
            const logKey = JSON.stringify({ screen: current.screen, myAccepted: current.myAccepted, decision });
            if (logKey !== lastLoggedKey) {
                log('trade_decision', {
                    requester,
                    screen: current.screen,
                    myAccepted: current.myAccepted,
                    ...decision,
                });
                lastLoggedKey = logKey;
            }

            if (decision.accept && !current.myAccepted) {
                await bot.acceptTrade();
                if (!sdk.getTradeState().isOpen) break;
            } else {
                await sdk.waitForTicks(2).catch(() => undefined);
            }
        }

        if (sdk.getTradeState().isOpen) {
            await bot.declineTrade();
            log('trade_result', {
                requester,
                success: false,
                message: 'Declined - no profitable offer reached in time',
            });
            return;
        }
        await sdk.waitForStateChange(2_000).catch(() => undefined);
        const inventoryAfter = summarizeInventory(sdk.getInventory());
        const { gave, received } = inventoryDelta(inventoryBefore, inventoryAfter);
        if (gave.length === 0 && received.length === 0) {
            log('trade_result', {
                requester,
                success: false,
                message: 'Trade session ended without an observable inventory exchange',
                gave,
                received,
                netProfitGp: 0,
            });
            return;
        }
        finishTrade(
            requester,
            gave,
            received,
            true,
            'Trade completed with observed inventory exchange'
        );
    }


    function finishTrade(
        requester: string,
        gave: TradeItem[],
        received: TradeItem[],
        success: boolean,
        message: string
    ): void {
        const gaveValue = estimateOfferValue(gave).total;
        const receivedValue = estimateOfferValue(received).total;
        const netProfitGp = receivedValue - gaveValue;
        if (success) recordTradeOutcome(netProfitGp);
        log('trade_result', { requester, success, message, gave, received, netProfitGp });
    }
});
