import { describe, expect, test } from 'bun:test';
import { BotActions } from '../actions';
import type { NearbyNpc, NearbyPlayer } from '../types';

const goblin: NearbyNpc = {
    kind: 'npc',
    id: 100,
    index: 4,
    name: 'Goblin',
    combatLevel: 2,
    x: 3200,
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

const rival: NearbyPlayer = {
    kind: 'player',
    index: 4, // deliberately the same number as the goblin's npc index
    name: 'Zezima',
    combatLevel: 42,
    x: 3200,
    z: 3200,
    distance: 1,
    reachable: true
};

interface StateOptions {
    /** Who we are facing, if anyone. */
    engaged?: 'npc' | 'player';
    message?: string;
    magicXp?: number;
}

function state({ engaged, message, magicXp = 0 }: StateOptions) {
    return {
        tick: message ? 2 : 1,
        revision: message ? 2 : 1,
        player: {
            worldX: 3200,
            worldZ: 3200,
            lifeId: 1,
            isDead: false,
            combat: {
                inCombat: engaged !== undefined,
                targetType: engaged ?? 'none',
                targetIndex: engaged ? 4 : -1,
                lastDamageTick: -1
            }
        },
        nearbyNpcs: [goblin],
        nearbyPlayers: [rival],
        skills: [{ name: 'Magic', level: 10, baseLevel: 10, experience: magicXp }],
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

/** A bot whose state flips to `final` as soon as an action has been dispatched. */
function createBot(final: ReturnType<typeof state>) {
    const dispatched: Array<{ call: string; args: unknown[] }> = [];
    let current = state({});
    const record = (call: string) => async (...args: unknown[]) => {
        dispatched.push({ call, args });
        return { success: true, message: 'dispatched', phase: 'dispatch' };
    };
    const sdk = {
        getState: () => current,
        findNearbyNpc: (pattern: string | RegExp) =>
            (typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern).test(goblin.name) ? goblin : null,
        findNearbyPlayer: (pattern: string | RegExp) =>
            (typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern).test(rival.name) ? rival : null,
        sendInteractNpc: record('sendInteractNpc'),
        sendInteractPlayer: record('sendInteractPlayer'),
        sendSpellOnTarget: record('sendSpellOnTarget'),
        waitForStateChange: async () => {
            current = final;
            return current;
        },
        waitForCondition: async () => {
            current = final;
            return current;
        }
    };
    return { bot: new BotActions(sdk as any), dispatched };
}

describe('BotActions.attack target dispatch', () => {
    test('sends the player attack option for a player target', async () => {
        const harness = createBot(state({ engaged: 'player' }));
        const result = await harness.bot.attack(rival);

        expect(result).toMatchObject({ success: true, targetType: 'player' });
        expect(harness.dispatched).toEqual([{ call: 'sendInteractPlayer', args: [rival.index, 2] }]);
    });

    test('does not mistake an npc fight for engagement with the same-numbered player', async () => {
        // npc index 4 and player slot 4 are different entities; only targetType tells them apart.
        const harness = createBot(state({ engaged: 'npc' }));
        const result = await harness.bot.attack(rival, 200);

        expect(result).toMatchObject({ success: false, reason: 'timeout', targetType: 'player' });
    });

    test('reports the wilderness refusal instead of a silent no-op', async () => {
        const harness = createBot(state({ message: "You can't attack players who aren't in the wilderness." }));
        const result = await harness.bot.attack(rival);

        expect(result).toMatchObject({ success: false, reason: 'not_attackable', targetType: 'player' });
        expect(result.message).toContain("aren't in the wilderness");
    });

    test('reports a single-way combat lock as retryable', async () => {
        const harness = createBot(state({ message: "I'm already under attack." }));
        const result = await harness.bot.attack(rival);

        expect(result).toMatchObject({ success: false, reason: 'already_in_combat' });
    });

    test('matches a name against npcs before players', async () => {
        const harness = createBot(state({ engaged: 'npc' }));
        const result = await harness.bot.attack('goblin');

        expect(result).toMatchObject({ success: true, targetType: 'npc' });
        expect(harness.dispatched).toEqual([{ call: 'sendInteractNpc', args: [goblin.index, 2] }]);
    });

    test('falls through to players when no npc matches', async () => {
        const harness = createBot(state({ engaged: 'player' }));
        const result = await harness.bot.attack('Zezima');

        expect(result).toMatchObject({ success: true, targetType: 'player' });
        expect(harness.dispatched).toEqual([{ call: 'sendInteractPlayer', args: [rival.index, 2] }]);
    });
});

describe('BotActions.castSpell target dispatch', () => {
    test('routes a player target through the player spell packet', async () => {
        const harness = createBot(state({ magicXp: 20 }));
        const result = await harness.bot.castSpell(rival, 1152);

        expect(result).toMatchObject({ success: true, hit: true, xpGained: 20, targetType: 'player' });
        expect(harness.dispatched).toEqual([{ call: 'sendSpellOnTarget', args: [rival, 1152] }]);
    });

    test('reports a PvP refusal rather than claiming a splash', async () => {
        const harness = createBot(state({ message: 'Your level difference is too great!' }));
        const result = await harness.bot.castSpell(rival, 1152);

        expect(result).toMatchObject({ success: false, reason: 'not_attackable', targetType: 'player' });
    });

    test('still splashes on npcs without magic xp', async () => {
        const harness = createBot(state({}));
        const result = await harness.bot.castSpell(goblin, 1152);

        expect(result).toMatchObject({ success: true, hit: false, xpGained: 0, targetType: 'npc' });
        expect(harness.dispatched).toEqual([{ call: 'sendSpellOnTarget', args: [goblin, 1152] }]);
    });
});
