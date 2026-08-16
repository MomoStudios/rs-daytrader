// DayTrader - Idle Economy
//
// Between chat polls, DayTrader should be productively finding items and
// opportunities that enable further trades - not standing still. Each
// exported function here is a single BOUNDED step (one gather attempt, one
// sell attempt) rather than a long-running loop, so the main loop stays
// responsive to chat and incoming trade requests. Strategy selection
// (which activity to do next) is simple and deterministic; it doesn't need
// LLM judgment call for the common case.

import type { BotActions } from '../../../sdk/actions';
import type { BotSDK } from '../../../sdk/index';
import { getValue } from './priceBook';
import { ESSENTIAL_TOOL_PATTERN } from './tradeEvaluator';
import { log } from './logger';

export interface EconomyContext {
    bot: BotActions;
    sdk: BotSDK;
}

/** Items DayTrader starts with / gathers that are fine to keep offering for sale. */
const SELLABLE_HINT_PATTERN = /log|ore|hide|feather|bone|shrimp|anchovi|fish|herb|flax|wool/i;

/**
 * One bounded idle step: look for the best available gathering action
 * nearby (tree > fishing spot > rock, in that priority order since low
 * level woodcutting/fishing are the fastest F2P income at level 1) and
 * perform ONE gather action. Returns a short description for logging.
 */
export async function doOneGatherStep(ctx: EconomyContext): Promise<string> {
    const { bot, sdk } = ctx;
    const state = sdk.getState();
    if (!state) return 'no state available';

    // Inventory full - nothing to gather into, skip.
    const freeSlots = 28 - state.inventory.length;
    if (freeSlots <= 0) return 'inventory full, skipping gather';

    // Priority 1: trees (woodcutting) - we start with a bronze axe.
    const tree = sdk.findNearbyLoc(/^tree$/i, { reachable: true });
    if (tree) {
        const result = await bot.chopTree(tree);
        log('idle_economy', { activity: 'chop_tree', success: result.success, message: result.message });
        return `chopTree: ${result.message}`;
    }

    // Priority 2: fishing spots (net/bait) - we start with a small fishing net.
    const spot = state.nearbyNpcs.find(
        npc => /fishing\s*spot/i.test(npc.name) && npc.optionsWithIndex.some(o => /^net$/i.test(o.text))
    );
    if (spot) {
        const result = await bot.interactNpc(spot, 'net');
        log('idle_economy', { activity: 'fish_net', success: result.success, message: result.message });
        return `fish: ${result.message}`;
    }

    // Priority 3: mineable rocks - we start with a bronze pickaxe.
    const rock = state.nearbyLocs.find(
        loc => /rocks?/i.test(loc.name) && loc.optionsWithIndex.some(o => /^mine$/i.test(o.text))
    );
    if (rock) {
        const result = await bot.interactLoc(rock, 'mine');
        log('idle_economy', { activity: 'mine_rock', success: result.success, message: result.message });
        return `mine: ${result.message}`;
    }

    return 'no gather target found nearby';
}

/**
 * One bounded idle step: pick up any nearby reachable ground item that has
 * a known, positive book value (dropped loot other players/bots left
 * behind is a legitimate, zero-cost source of tradeable stock).
 */
export async function doOnePickupStep(ctx: EconomyContext): Promise<string> {
    const { bot, sdk } = ctx;
    const state = sdk.getState();
    if (!state) return 'no state available';
    if (28 - state.inventory.length <= 0) return 'inventory full, skipping pickup';

    const candidates = (state.groundItems ?? [])
        .filter(item => item.reachable !== false)
        .filter(item => {
            const value = getValue(item.name);
            return value !== null && value > 0;
        })
        .sort((a, b) => a.distance - b.distance);

    const target = candidates[0];
    if (!target) return 'no valuable ground item nearby';

    const result = await bot.pickupItem(target);
    log('idle_economy', { activity: 'pickup', item: target.name, success: result.success, message: result.message });
    return `pickup ${target.name}: ${result.message}`;
}

/** Names of inventory items worth advertising/selling right now (excess gathered stock). */
export function getSellableItemNames(ctx: EconomyContext): string[] {
    const state = ctx.sdk.getState();
    if (!state) return [];
    const names = state.inventory
        .filter(i => SELLABLE_HINT_PATTERN.test(i.name) && !ESSENTIAL_TOOL_PATTERN.test(i.name))
        .map(i => i.name);
    return [...new Set(names)];
}

/**
 * One bounded idle step for when the inventory is getting full: find a
 * nearby shopkeeper and sell one stack of a gathered, non-essential item
 * (logs, ore, hides, fish, etc.) so gathering can continue and so DayTrader
 * accumulates coins (the universal medium for the buy/sell trades chat
 * monitoring is looking for). Only ever sells items priceBook confirms
 * have a positive value, and never touches essential tools (see
 * tradeEvaluator's ESSENTIAL_TOOL_PATTERN) or valuable equipped-looking
 * gear (weapons/armour) that's worth more traded to a player than sold to
 * a general store.
 */
export async function trySellExcessToShop(ctx: EconomyContext): Promise<string> {
    const { bot, sdk } = ctx;
    const state = sdk.getState();
    if (!state) return 'no state available';

    const excess = state.inventory.filter(
        i => SELLABLE_HINT_PATTERN.test(i.name) && !ESSENTIAL_TOOL_PATTERN.test(i.name) && getValue(i.name) !== null
    );
    if (excess.length === 0) return 'nothing sellable to offload';

    if (!state.shop.isOpen) {
        const shopkeeper =
            sdk.findNearbyNpc(/shop\s*keeper|shop\s*assistant|^bob$/i, {
                reachable: true,
            }) ??
            state.nearbyNpcs
                .filter(npc => npc.reachable !== false)
                .filter(npc =>
                    npc.optionsWithIndex.some(option => /^trade$/i.test(option.text))
                )
                .sort((a, b) => a.distance - b.distance)[0];
        if (!shopkeeper) return 'no shop nearby to sell at';

        const opened = await bot.openShop(shopkeeper);
        if (!opened.success) return `could not open shop: ${opened.message}`;
    }

    const item = excess[0];
    const result = await bot.sellToShop(item.name, item.count);
    await bot.closeShop();
    log('idle_economy', {
        activity: 'sell_to_shop',
        item: item.name,
        count: item.count,
        success: result.success,
        message: (result as { message?: string }).message,
    });
    return `sellToShop ${item.name} x${item.count}: ${result.success}`;
}

const BANK_LOCATIONS = [
    { name: 'Draynor Bank', x: 3092, z: 3243 },
    { name: 'Varrock West Bank', x: 3185, z: 3436 },
] as const;

/**
 * Deterministic capacity recovery used when no operator workflow is available.
 * Bank resources rather than repeatedly calling a gather action that cannot
 * succeed. Essential tools remain carried.
 */
export async function recoverInventoryCapacity(ctx: EconomyContext): Promise<string> {
    const { bot, sdk } = ctx;
    const state = sdk.getState();
    if (!state?.player) return 'no state available';
    if (state.inventory.length < 28) return 'inventory already has free space';

    if (state.bank.isOpen) {
        const candidate = state.inventory.find(
            item => !ESSENTIAL_TOOL_PATTERN.test(item.name)
        );
        if (!candidate) return 'inventory full with only protected tools';
        const deposited = await bot.depositItem(candidate.name, -1);
        if (deposited.success) await bot.closeBank();
        log('idle_economy', {
            activity: 'bank_capacity_recovery',
            item: candidate.name,
            success: deposited.success,
            message: deposited.message,
        });
        return deposited.message;
    }
    if (state.interface.isOpen || state.dialog.isOpen || state.modalOpen) {
        return `blocking interface ${state.interface.interfaceId} prevents capacity recovery`;
    }

    const bankTarget =
        sdk.findNearbyLoc(/bank booth|bank chest/i, { reachable: true }) ??
        sdk.findNearbyNpc(/banker/i, { reachable: true });
    if (bankTarget) {
        const opened = await bot.openBank();
        return opened.message;
    }

    const nearest = [...BANK_LOCATIONS].sort(
        (a, b) =>
            Math.hypot(state.player!.worldX - a.x, state.player!.worldZ - a.z) -
            Math.hypot(state.player!.worldX - b.x, state.player!.worldZ - b.z)
    )[0]!;
    const walked = await bot.walkTo(nearest.x, nearest.z, 4);
    log('idle_economy', {
        activity: 'walk_to_bank_for_capacity',
        bank: nearest.name,
        success: walked.success,
        message: walked.message,
    });
    return walked.message;
}
