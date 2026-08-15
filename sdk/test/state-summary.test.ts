import { describe, expect, test } from 'bun:test';
import { formatWorldStateSummary } from '../formatter';
import type { BotWorldState } from '../types';

function state(overrides: Partial<BotWorldState> = {}): BotWorldState {
    return {
        tick: 100,
        inGame: true,
        player: {
            name: 'testbot',
            worldX: 3222,
            worldZ: 3218,
            level: 0,
            combatLevel: 3,
            isDead: false,
            lifeId: 1,
            respawnCount: 0,
            combat: { inCombat: false, targetIndex: -1 }
        } as any,
        skills: [
            { name: 'Hitpoints', level: 7, baseLevel: 10, experience: 1300 },
            { name: 'Woodcutting', level: 5, baseLevel: 5, experience: 500 }
        ] as any,
        inventory: [],
        equipment: [],
        nearbyNpcs: [],
        nearbyPlayers: [],
        nearbyLocs: [],
        groundItems: [],
        gameMessages: [],
        recentDialogs: [],
        dialog: { isOpen: false, isWaiting: false, options: [] } as any,
        interface: { isOpen: false, interfaceId: -1, options: [] } as any,
        shop: { isOpen: false, title: '', shopItems: [], playerItems: [] } as any,
        bank: { isOpen: false, items: [] } as any,
        modalOpen: false,
        modalInterface: -1,
        combatEvents: [],
        prayers: { activePrayers: [], prayerPoints: 1, prayerLevel: 1 } as any,
        ...overrides
    };
}

describe('formatWorldStateSummary', () => {
    test('stays short even for a busy world', () => {
        const busy = state({
            nearbyLocs: Array.from({ length: 120 }, (_, i) => ({ name: `Tree ${i}`, x: i, z: i, distance: i, options: ['Chop down'] })) as any,
            nearbyNpcs: Array.from({ length: 30 }, (_, i) => ({ name: `Man ${i}`, index: i, distance: i, combatLevel: 2, hp: null, maxHp: null, inCombat: false, options: ['Talk-to'] })) as any,
            groundItems: Array.from({ length: 20 }, (_, i) => ({ name: `Item ${i}`, count: 1, x: i, z: i, distance: i })) as any
        });

        const out = formatWorldStateSummary(busy, 0);

        expect(out.split('\n').length).toBeLessThanOrEqual(8);
        expect(out).toContain('Pos (3222, 3218)');
        expect(out).toContain('HP 7/10');
        expect(out).toContain('Objs: Tree 0 (0t)');
        expect(out).toContain('+115 more');
        expect(out).toContain('+25 more');
        expect(out).toContain('+16 more');
    });

    test('groups nearby entities by name, nearest first', () => {
        const world = state({
            nearbyLocs: [
                { name: 'Oak', x: 0, z: 0, distance: 6, options: [] },
                { name: 'Tree', x: 0, z: 0, distance: 4, options: [] },
                { name: 'Tree', x: 0, z: 0, distance: 2, options: [] }
            ] as any,
            groundItems: [{ name: 'Coins', count: 34, x: 0, z: 0, distance: 1 }] as any,
            nearbyPlayers: [{ name: 'Zezima', combatLevel: 126, distance: 4 }] as any
        });

        const out = formatWorldStateSummary(world, 0);

        expect(out).toContain('Objs: Tree x2 (2t), Oak (6t)');
        expect(out).toContain('Ground: Coins x34 (1t)');
        expect(out).toContain('Players: Zezima (4t)');
        expect(out).not.toContain('NPCs:');
    });

    test('reports xp gained per skill', () => {
        const out = formatWorldStateSummary(state(), 0, {
            xpBefore: { Hitpoints: 1300, Woodcutting: 220 }
        });

        expect(out).toContain('XP: Woodcutting +280');
    });

    test('reports no xp when nothing moved', () => {
        const out = formatWorldStateSummary(state(), 0, {
            xpBefore: { Hitpoints: 1300, Woodcutting: 500 }
        });

        expect(out).toContain('XP: none gained');
    });

    test('summarizes inventory and truncates long lists', () => {
        const inv = state({
            inventory: [
                { slot: 0, id: 1, name: 'Coins', count: 543, optionsWithIndex: [] },
                ...Array.from({ length: 10 }, (_, i) => ({ slot: i + 1, id: i + 2, name: `Item ${i}`, count: 1, optionsWithIndex: [] }))
            ] as any
        });

        const out = formatWorldStateSummary(inv, 0);

        expect(out).toContain('Inv 11/28: Coins x543');
        expect(out).toContain('+3 more');
    });

    test('flags blocking UI and shows the last few messages', () => {
        const blocked = state({
            dialog: { isOpen: true, isWaiting: false, options: [{ index: 1, text: 'Yes' }] } as any,
            gameMessages: [
                { tick: 1, text: 'You get some logs.', type: 0, sender: null, fromSelf: false },
                { tick: 2, text: "I can't reach that!", type: 0, sender: null, fromSelf: false },
                { tick: 3, text: "I can't reach that!", type: 0, sender: null, fromSelf: false }
            ] as any
        });

        const out = formatWorldStateSummary(blocked, 0);

        expect(out).toContain('[!] dialog open (1 options)');
        expect(out).toContain("> I can't reach that! (x2)");
    });
});
