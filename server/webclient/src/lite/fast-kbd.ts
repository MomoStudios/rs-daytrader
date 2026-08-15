import type { BotWorldState } from '#/bot/types.js';

export const FAST_KBD_RUNTIME_MODE = 'kbd-fast-attack-v4';

const RUNE_2H = /^rune 2h sword$/i;
const BONES = /bones$/i;
const IGNORED_KBD_LOOT = /^(?:coins|gold ring|uncut (?:sapphire|emerald|ruby|diamond))$/i;
const KBD_PROTECT_MAGIC_HP_THRESHOLD = 65;

function valuableKbdLootSlots(state: BotWorldState): number {
    return state.inventory.filter(item =>
        !BONES.test(item.name) && !IGNORED_KBD_LOOT.test(item.name)
    ).length;
}

/** The durable one-item policy conditions shared by the attack and prayer-off hooks. */
export function isFastKbdPolicyState(state: BotWorldState): boolean {
    const player = state.player;
    if (!player
        || player.isDead
        || player.worldX < 2688 || player.worldX >= 2752
        || player.worldZ < 9792 || player.worldZ >= 9856
        || state.modalOpen
        || state.dialog.isOpen
        || state.equipment.length !== 1
        || !RUNE_2H.test(state.equipment[0].name)
        || state.inventory.some(item => IGNORED_KBD_LOOT.test(item.name))) {
        return false;
    }

    return valuableKbdLootSlots(state) < 3;
}

/**
 * Return the one NPC index the Lite runner may attack before publishing state.
 * This mirrors the durable fleet policy narrowly enough that the generic
 * runner cannot start combat anywhere else or while a bank return is due.
 */
export function findFastKbdAttackTarget(state: BotWorldState): number | undefined {
    if (!isFastKbdPolicyState(state)) return undefined;

    return state.nearbyNpcs.find(npc =>
        npc.name === 'King black dragon' && npc.reachable !== false
    )?.index;
}

/**
 * Inactive prayers to switch on immediately before the first KBD op2 packet.
 * Interface-button packets are decoded before player interactions in the next
 * server cycle, so these boosts apply to that same first swing without paying
 * several pre-spawn drain ticks.
 */
export function findFastKbdPrayerOnIndices(state: BotWorldState): number[] {
    const player = state.player;
    if (!player || !isFastKbdPolicyState(state) || state.prayers.prayerPoints <= 0) return [];

    const level = state.prayers.prayerLevel;
    const indices: number[] = [];
    if (level >= 31) indices.push(10); // Ultimate Strength
    else if (level >= 13) indices.push(4); // Superhuman Strength
    else if (level >= 4) indices.push(1); // Burst of Strength

    if (level >= 34) indices.push(11); // Incredible Reflexes
    else if (level >= 16) indices.push(5); // Improved Reflexes
    else if (level >= 7) indices.push(2); // Clarity of Thought

    if ((player.hp ?? Number.MAX_SAFE_INTEGER) <= KBD_PROTECT_MAGIC_HP_THRESHOLD
        && level >= 37) {
        indices.push(12); // Protect from Magic
    }
    if (valuableKbdLootSlots(state) > 0 && level >= 25) {
        indices.push(8); // Protect Item
    }

    return indices.filter(index => !state.prayers.activePrayers[index]);
}

/** Active prayers the runner may disable during a confirmed post-KBD off phase. */
export function findFastKbdPrayerOffIndices(
    state: BotWorldState,
    prayerOffPending: boolean,
): number[] {
    if (!prayerOffPending
        || !isFastKbdPolicyState(state)
        || state.nearbyNpcs.some(npc => npc.name === 'King black dragon')) {
        return [];
    }
    return state.prayers.activePrayers.flatMap((active, index) => active ? [index] : []);
}
