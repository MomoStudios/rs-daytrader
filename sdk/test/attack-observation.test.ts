import { describe, expect, test } from 'bun:test';
import { BotActions } from '../actions';
import type { NearbyNpc } from '../types';

const target: NearbyNpc = {
    kind: 'npc',
    id: 9,
    index: 42,
    name: 'Guard',
    combatLevel: 21,
    x: 3201,
    z: 3200,
    distance: 1,
    hp: null,
    maxHp: null,
    healthPercent: null,
    targetIndex: -1,
    inCombat: false,
    lastCombatTick: null,
    animId: -1,
    spotanimId: -1,
    optionsWithIndex: [{ text: 'Attack', opIndex: 2 }],
    options: ['Attack'],
    reachable: true
};

function state(targetIndex: number, message?: string, attackXp: number = 0) {
    return {
        tick: message ? 2 : 1,
        revision: message ? 2 : 1,
        player: {
            worldX: 3200,
            worldZ: 3200,
            lifeId: 1,
            isDead: false,
            combat: { inCombat: targetIndex >= 0, targetIndex, targetType: targetIndex >= 0 ? 'npc' : 'none', lastDamageTick: -1 }
        },
        nearbyNpcs: [target],
        skills: [
            { name: 'Attack', level: 1, baseLevel: 1, experience: attackXp },
            { name: 'Strength', level: 1, baseLevel: 1, experience: 0 },
            { name: 'Defence', level: 1, baseLevel: 1, experience: 0 },
            { name: 'Hitpoints', level: 10, baseLevel: 10, experience: 1_154 }
        ],
        gameMessages: message
            ? [{ tick: 2, text: message, type: 0, sender: '', fromSelf: false }]
            : [],
        combatEvents: [],
        dialog: { isOpen: false, options: [], isWaiting: false },
        interface: { isOpen: false, interfaceId: -1, options: [] },
        shop: { isOpen: false },
        bank: { isOpen: false }
    } as any;
}

function createBot(finalTargetIndex: number, finalAttackXp: number = 0, interrupted: boolean = false) {
    const initial = state(-1);
    let current = initial;
    const final = state(finalTargetIndex, "I'm already under attack!", finalAttackXp);
    final.dialog.isOpen = interrupted;
    let dismissCount = 0;
    const sdk = {
        getState: () => current,
        sendInteractNpc: async () => ({ success: true, message: 'dispatched', phase: 'dispatch' }),
        waitForStateChange: async () => {
            if (current === initial) current = final;
            return current;
        },
        sendClickDialog: async () => {
            dismissCount++;
            current = { ...current, dialog: { ...current.dialog, isOpen: false } };
            return { success: true, message: 'dismissed' };
        }
    };
    return { bot: new BotActions(sdk as any), getDismissCount: () => dismissCount };
}

describe('BotActions.attack observation (npc)', () => {
    test('treats a refusal race as success when the requested target is engaged', async () => {
        const result = await createBot(target.index).bot.attack(target);
        expect(result).toEqual({ success: true, message: 'Already fighting Guard', targetType: 'npc' });
    });

    test('does not use XP from an existing fight as proof the requested target was engaged', async () => {
        // The player is fighting NPC A (#7), gains XP from A, and receives a
        // refusal after trying NPC B (#42). B must not be reported as engaged.
        const result = await createBot(7, 40).bot.attack(target);
        expect(result).toMatchObject({ success: false, reason: 'already_in_combat' });
    });

    test('dismisses a safe modal before returning satisfied combat evidence', async () => {
        const harness = createBot(target.index, 0, true);
        const result = await harness.bot.attack(target);

        expect(result.success).toBeTrue();
        expect(harness.getDismissCount()).toBe(1);
    });
});
