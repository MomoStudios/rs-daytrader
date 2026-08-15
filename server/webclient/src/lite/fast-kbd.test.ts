import { describe, expect, test } from 'bun:test';

import type { BotWorldState } from '#/bot/types.js';
import {
    findFastKbdAttackTarget,
    findFastKbdPrayerOffIndices,
    findFastKbdPrayerOnIndices,
    isFastKbdPolicyState,
} from './fast-kbd.js';

function state(overrides: Record<string, unknown> = {}): BotWorldState {
    return {
        player: { worldX: 2718, worldZ: 9819, isDead: false },
        modalOpen: false,
        dialog: { isOpen: false },
        equipment: [{ name: 'Rune 2h sword' }],
        inventory: [],
        nearbyNpcs: [{ name: 'King black dragon', index: 2771, reachable: true }],
        prayers: { activePrayers: Array(15).fill(false), prayerPoints: 70, prayerLevel: 70 },
        ...overrides,
    } as unknown as BotWorldState;
}

describe('runner-side KBD fast attack eligibility', () => {
    test('selects the exact KBD from the one-item lair state', () => {
        expect(findFastKbdAttackTarget(state())).toBe(2771);
    });

    test('allows two retained valuable slots but not a due bank return', () => {
        expect(findFastKbdAttackTarget(state({
            inventory: [{ name: 'Dragonhide' }, { name: 'Coal' }],
        }))).toBe(2771);
        expect(findFastKbdAttackTarget(state({
            inventory: [{ name: 'Dragonhide' }, { name: 'Coal' }, { name: 'Yew logs' }],
        }))).toBeUndefined();
    });

    test('rejects forbidden loot, blocking UI, and positions outside KBD', () => {
        expect(findFastKbdAttackTarget(state({ inventory: [{ name: 'Coins' }] }))).toBeUndefined();
        expect(findFastKbdAttackTarget(state({ modalOpen: true }))).toBeUndefined();
        expect(findFastKbdAttackTarget(state({
            player: { worldX: 3094, worldZ: 3957, isDead: false },
        }))).toBeUndefined();
    });

    test('recognises the reusable one-item policy without a live dragon', () => {
        expect(isFastKbdPolicyState(state({ nearbyNpcs: [] }))).toBe(true);
    });

    test('switches active prayers off only during a policy-gated post-KBD phase', () => {
        const activePrayers = Array(15).fill(false);
        activePrayers[10] = true;
        activePrayers[11] = true;
        activePrayers[12] = true;
        const removed = state({
            nearbyNpcs: [],
            prayers: { activePrayers, prayerPoints: 60, prayerLevel: 70 },
        });
        expect(findFastKbdPrayerOffIndices(removed, true)).toEqual([10, 11, 12]);
        expect(findFastKbdPrayerOffIndices(removed, false)).toEqual([]);
        expect(findFastKbdPrayerOffIndices(state({
            prayers: { activePrayers, prayerPoints: 60, prayerLevel: 70 },
        }), true)).toEqual([]);
    });

    test('switches damage prayers on for the spawn tick and adds bounded protection', () => {
        expect(findFastKbdPrayerOnIndices(state())).toEqual([10, 11]);
        expect(findFastKbdPrayerOnIndices(state({
            player: { worldX: 2718, worldZ: 9819, isDead: false, hp: 60 },
            inventory: [{ name: 'Dragonhide' }],
        }))).toEqual([10, 11, 12, 8]);
    });

    test('does not re-toggle active or unavailable spawn prayers', () => {
        const activePrayers = Array(15).fill(false);
        activePrayers[10] = true;
        activePrayers[11] = true;
        expect(findFastKbdPrayerOnIndices(state({
            prayers: { activePrayers, prayerPoints: 60, prayerLevel: 70 },
        }))).toEqual([]);
        expect(findFastKbdPrayerOnIndices(state({
            prayers: { activePrayers: Array(15).fill(false), prayerPoints: 0, prayerLevel: 70 },
        }))).toEqual([]);
    });
});
