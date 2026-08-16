import type { BotActions } from '../../../sdk/actions';
import type { BotSDK } from '../../../sdk/index';
import type { InventoryItem } from '../../../sdk/types';
import type { Destination, ProgressionActivity, StrategicAction } from './aiDecision';
import {
    doOneGatherStep,
    doOnePickupStep,
    recoverInventoryCapacity,
    trySellExcessToShop,
} from './economy';
import { log } from './logger';

export interface SkillContext {
    bot: BotActions;
    sdk: BotSDK;
}

export interface SkillResult {
    success: boolean;
    action: string;
    message: string;
}

interface DestinationDefinition {
    x: number;
    z: number;
    description: string;
}

export const DESTINATION_LIBRARY: Readonly<Record<Destination, DestinationDefinition>> = Object.freeze({
    lumbridge_market: { x: 3210, z: 3244, description: 'Lumbridge General Store and player market' },
    lumbridge_trees: { x: 3195, z: 3220, description: 'safe regular trees west of Lumbridge' },
    lumbridge_range: { x: 3230, z: 3196, description: 'usable Lumbridge range' },
    lumbridge_furnace: { x: 3225, z: 3256, description: 'Lumbridge furnace' },
    draynor_fishing: { x: 3087, z: 3230, description: 'Draynor net fishing spots' },
    varrock_oaks: { x: 3190, z: 3458, description: 'Varrock oak trees' },
    draynor_willows: { x: 3087, z: 3230, description: 'Draynor willow trees; only for stronger characters' },
    se_varrock_mine: { x: 3285, z: 3365, description: 'SE Varrock copper, tin, and iron mine' },
    varrock_anvil: { x: 3188, z: 3421, description: 'Varrock west anvils' },
});

function distanceTo(ctx: SkillContext, destination: Destination): number {
    const player = ctx.sdk.getState()?.player;
    if (!player) return Infinity;
    const target = DESTINATION_LIBRARY[destination];
    return Math.hypot(player.worldX - target.x, player.worldZ - target.z);
}

async function travel(ctx: SkillContext, destination: Destination): Promise<SkillResult> {
    if (
        destination === 'varrock_anvil' &&
        (!firstInventoryItem(ctx, /bar$/i) || !firstInventoryItem(ctx, /^hammer$/i))
    ) {
        return {
            success: false,
            action: `travel:${destination}`,
            message: 'Anvil travel rejected: acquire a hammer and metal bars first',
        };
    }
    const target = DESTINATION_LIBRARY[destination];
    const result = await ctx.bot.walkTo(target.x, target.z);
    return {
        success: result.success,
        action: `travel:${destination}`,
        message: `${target.description}: ${result.message}`,
    };
}

function firstInventoryItem(ctx: SkillContext, pattern: RegExp): InventoryItem | null {
    return ctx.sdk.getInventory().find(item => pattern.test(item.name)) ?? null;
}

async function trainWoodcutting(ctx: SkillContext): Promise<SkillResult> {
    const level = ctx.sdk.getSkill('Woodcutting')?.baseLevel ?? 1;
    const combatLevel = ctx.sdk.getState()?.player?.combatLevel ?? 3;
    const target =
        level >= 30 && combatLevel >= 20
            ? { pattern: /^willow$/i, destination: 'draynor_willows' as const }
            : level >= 15
              ? { pattern: /^oak$/i, destination: 'varrock_oaks' as const }
              : { pattern: /^tree$/i, destination: 'lumbridge_trees' as const };
    const tree = ctx.sdk.findNearbyLoc(target.pattern, { reachable: true, withOption: /chop/i });
    if (!tree || distanceTo(ctx, target.destination) > 20) return travel(ctx, target.destination);
    const result = await ctx.bot.chopTree(tree);
    return { success: result.success, action: `train:woodcutting:${tree.name}`, message: result.message };
}

async function trainFishing(ctx: SkillContext): Promise<SkillResult> {
    const state = ctx.sdk.getState();
    if (!state) return { success: false, action: 'train:fishing', message: 'No game state' };
    const spot = state.nearbyNpcs.find(
        npc =>
            /fishing\s*spot/i.test(npc.name) &&
            npc.optionsWithIndex.some(option => /^net$/i.test(option.text))
    );
    if (!spot || distanceTo(ctx, 'draynor_fishing') > 20) return travel(ctx, 'draynor_fishing');
    const result = await ctx.bot.interactNpc(spot, 'net');
    return { success: result.success, action: 'train:fishing:net', message: result.message };
}

async function trainMining(ctx: SkillContext): Promise<SkillResult> {
    const miningPriority = (name: string): number => {
        if (/runite/i.test(name)) return 7;
        if (/adamant/i.test(name)) return 6;
        if (/mithril/i.test(name)) return 5;
        if (/coal/i.test(name)) return 4;
        if (/iron/i.test(name)) return 3;
        if (/tin|copper/i.test(name)) return 2;
        return 0;
    };
    const candidates = (ctx.sdk.getState()?.nearbyLocs ?? [])
        .filter(location => location.reachable !== false)
        .filter(location => location.optionsWithIndex.some(option => /^mine$/i.test(option.text)))
        .filter(location => miningPriority(location.name) > 0)
        .sort(
            (a, b) =>
                miningPriority(b.name) - miningPriority(a.name) ||
                a.distance - b.distance
        );
    let rock = candidates[0];
    if (!rock && distanceTo(ctx, 'se_varrock_mine') <= 25) {
        // Depleted rocks temporarily lose their ore-specific Mine target.
        // Wait for a bounded respawn and re-observe instead of clicking generic
        // "Rocks", which produces no Mining XP.
        await ctx.sdk.waitForTicks(10);
        rock = (ctx.sdk.getState()?.nearbyLocs ?? [])
            .filter(location => location.reachable !== false)
            .filter(location =>
                location.optionsWithIndex.some(option => /^mine$/i.test(option.text))
            )
            .filter(location => miningPriority(location.name) > 0)
            .sort(
                (a, b) =>
                    miningPriority(b.name) - miningPriority(a.name) ||
                    a.distance - b.distance
            )[0];
    }
    if (!rock || distanceTo(ctx, 'se_varrock_mine') > 25) {
        return travel(ctx, 'se_varrock_mine');
    }
    const result = await ctx.bot.interactLoc(rock, 'mine');
    return { success: result.success, action: `train:mining:${rock.name}`, message: result.message };
}

async function trainFiremaking(ctx: SkillContext): Promise<SkillResult> {
    const logs = firstInventoryItem(ctx, /logs$/i);
    if (!logs) {
        return { success: false, action: 'train:firemaking', message: 'Need logs; train woodcutting first' };
    }
    const result = await ctx.bot.burnLogs(logs);
    return { success: result.success, action: `train:firemaking:${logs.name}`, message: result.message };
}

async function trainCooking(ctx: SkillContext): Promise<SkillResult> {
    const rawFood = firstInventoryItem(ctx, /^raw\s+/i);
    if (!rawFood) {
        return { success: false, action: 'train:cooking', message: 'Need raw food; train fishing first' };
    }
    const range = ctx.sdk.findNearbyLoc(/^range$/i, { reachable: true });
    if (!range || distanceTo(ctx, 'lumbridge_range') > 15) return travel(ctx, 'lumbridge_range');
    const result = await ctx.bot.useItemOnLoc(rawFood, range);
    return { success: result.success, action: `train:cooking:${rawFood.name}`, message: result.message };
}

async function trainSmithing(ctx: SkillContext): Promise<SkillResult> {
    const bar = firstInventoryItem(ctx, /bar$/i);
    const hammer = firstInventoryItem(ctx, /^hammer$/i);
    if (bar && hammer) {
        const anvil = ctx.sdk.findNearbyLoc(/anvil/i, { reachable: true });
        if (!anvil || distanceTo(ctx, 'varrock_anvil') > 15) return travel(ctx, 'varrock_anvil');
        const result = await ctx.bot.smithAtAnvil('dagger', { barPattern: new RegExp(bar.name, 'i') });
        return { success: result.success, action: `train:smithing:${bar.name}`, message: result.message };
    }
    const copper = firstInventoryItem(ctx, /^copper ore$/i);
    const tin = firstInventoryItem(ctx, /^tin ore$/i);
    if (copper && tin) {
        const furnace = ctx.sdk.findNearbyLoc(/furnace/i, { reachable: true, withOption: /smelt/i });
        if (!furnace || distanceTo(ctx, 'lumbridge_furnace') > 15) return travel(ctx, 'lumbridge_furnace');
        const before = ctx.sdk.getSkill('Smithing')?.experience ?? 0;
        const dispatched = await ctx.sdk.sendUseItemOnLoc(copper.slot, furnace.x, furnace.z, furnace.id);
        if (!dispatched) {
            return { success: false, action: 'train:smithing:smelt', message: 'Smelt interaction was rejected' };
        }
        try {
            await ctx.sdk.waitForCondition(
                state => (state.skills.find(skill => skill.name === 'Smithing')?.experience ?? 0) > before,
                12_000
            );
            return { success: true, action: 'train:smithing:smelt', message: 'Smelted ore at furnace' };
        } catch {
            return { success: false, action: 'train:smithing:smelt', message: 'Timed out waiting for Smithing XP' };
        }
    }
    return {
        success: false,
        action: 'train:smithing',
        message: 'Need a hammer and bars, or matching copper and tin ore',
    };
}

async function train(ctx: SkillContext, activity: ProgressionActivity): Promise<SkillResult> {
    switch (activity) {
        case 'woodcutting':
            return trainWoodcutting(ctx);
        case 'fishing':
            return trainFishing(ctx);
        case 'mining':
            return trainMining(ctx);
        case 'firemaking':
            return trainFiremaking(ctx);
        case 'cooking':
            return trainCooking(ctx);
        case 'smithing':
            return trainSmithing(ctx);
    }
}

export async function executeStrategicAction(ctx: SkillContext, action: StrategicAction): Promise<SkillResult> {
    let result: SkillResult;
    switch (action.type) {
        case 'train':
            result = await train(ctx, action.activity);
            break;
        case 'travel':
            result = await travel(ctx, action.destination);
            break;
        case 'sell_excess': {
            const message = await trySellExcessToShop(ctx);
            result = { success: !/^(no |nothing|could not)/i.test(message), action: 'sell_excess', message };
            break;
        }
        case 'pickup': {
            const message = await doOnePickupStep(ctx);
            result = { success: !/^no /i.test(message), action: 'pickup', message };
            break;
        }
        case 'wait':
            await ctx.sdk.waitForTicks(2);
            result = { success: true, action: 'wait', message: 'Waited two ticks' };
            break;
        default: {
            const exhaustive: never = action;
            throw new Error(`Unhandled strategic action: ${JSON.stringify(exhaustive)}`);
        }
    }
    log('skill_action', { ...result });
    return result;
}

export async function executeFallbackAction(ctx: SkillContext): Promise<SkillResult> {
    if ((ctx.sdk.getState()?.inventory.length ?? 0) >= 28) {
        const message = await recoverInventoryCapacity(ctx);
        const result = {
            success: !/^(no |inventory full with)/i.test(message),
            action: 'fallback:capacity_recovery',
            message,
        };
        log('skill_action', { ...result });
        return result;
    }
    const message = await doOneGatherStep(ctx);
    const result = { success: !/^no |^inventory full/i.test(message), action: 'fallback:gather', message };
    log('skill_action', { ...result });
    return result;
}
