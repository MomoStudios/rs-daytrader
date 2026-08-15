#!/usr/bin/env bun
/**
 * Combat Style Metadata Test
 *
 * Equips one weapon per category and checks the published combat styles against
 * the server's own tables (skill_combat/configs/combat.dbrow). The styles used to
 * be guessed from the weapon's *name*, which put a controlled style on a bronze
 * sword's index 2 - the server has aggressive/Strength there.
 *
 * Run against a local server:
 *   bun sdk/test/combat-style-metadata.ts
 *   HEADLESS=true PUPPETEER=true bun sdk/test/combat-style-metadata.ts
 */

import { launchBotWithSDK, sleep } from './utils/browser';
import { generateSave, Items, Locations } from './utils/save-generator';

const BOT_NAME = process.env.BOT_NAME || 'stylebot';

/** What each weapon's tab should publish, per combat.dbrow + the tab's own labels. */
const EXPECTED = [
    {
        weapon: 'Bronze sword', id: Items.BRONZE_SWORD, tab: 2276, // weapon_stab
        styles: ['Stab/Accurate/Attack/Stab', 'Lunge/Aggressive/Strength/Stab', 'Slash/Aggressive/Strength/Slash', 'Block/Defensive/Defence/Stab']
    },
    {
        weapon: 'Bronze scimitar', id: 1321, tab: 2423, // weapon_slash
        styles: ['Chop/Accurate/Attack/Slash', 'Slash/Aggressive/Strength/Slash', 'Lunge/Controlled/Attack+Strength+Defence/Stab', 'Block/Defensive/Defence/Slash']
    },
    {
        weapon: 'Bronze mace', id: 1422, tab: 425, // weapon_blunt
        styles: ['Pound/Accurate/Attack/Crush', 'Pummel/Aggressive/Strength/Crush', 'Block/Defensive/Defence/Crush']
    },
    {
        weapon: 'Bronze axe', id: Items.BRONZE_AXE, tab: 1698, // weapon_axe
        styles: ['Chop/Accurate/Attack/Slash', 'Hack/Aggressive/Strength/Slash', 'Smash/Aggressive/Strength/Crush', 'Block/Defensive/Defence/Slash']
    },
    {
        weapon: 'Bronze 2h sword', id: 1307, tab: 4705, // weapon_2h_sword
        styles: ['Chop/Accurate/Attack/Slash', 'Slash/Aggressive/Strength/Slash', 'Smash/Aggressive/Strength/Crush', 'Block/Defensive/Defence/Slash']
    },
    {
        weapon: 'Shortbow', id: Items.SHORTBOW, tab: 1764, // weapon_bow
        styles: ['Accurate/Accurate/Ranged/Ranged', 'Rapid/Rapid/Ranged/Ranged', 'Longrange/Longrange/Ranged+Defence/Ranged']
    }
];

const UNARMED = ['Punch/Accurate/Attack/Crush', 'Kick/Aggressive/Strength/Crush', 'Block/Defensive/Defence/Crush'];

const describe = (styles: Array<{ name: string; type: string; trainsSkills: string[]; damageType: string }>) =>
    styles.map(s => `${s.name}/${s.type}/${s.trainsSkills.join('+')}/${s.damageType}`);

async function main(): Promise<boolean> {
    await generateSave(BOT_NAME, {
        position: Locations.LUMBRIDGE_CASTLE,
        skills: { Attack: 20, Strength: 20, Defence: 20, Hitpoints: 20, Ranged: 20, Magic: 20 },
        inventory: EXPECTED.map(e => ({ id: e.id, count: 1 })),
        varps: { 281: 1000 } // tutorial complete
    });

    const session = await launchBotWithSDK(BOT_NAME, {
        headless: process.env.HEADLESS === 'true',
        usePuppeteer: process.env.PUPPETEER === 'true',
        exitOnCleanup: false
    });
    const { sdk, bot } = session;
    let passed = true;

    try {
        const only = process.env.ONLY?.toLowerCase();
        for (const expected of EXPECTED.filter(e => !only || e.weapon.toLowerCase().includes(only))) {
            const equipped = await bot.equipItem(expected.weapon);
            if (!equipped.success) {
                console.log(`FAIL ${expected.weapon}: could not equip (${equipped.message})`);
                passed = false;
                continue;
            }
            await sleep(900); // the server sends the new tab a tick or two later

            const style = sdk.getState()?.combatStyle;
            const actual = describe(style?.styles ?? []);
            const ok = style?.known === true
                && style.tabInterfaceId === expected.tab
                && JSON.stringify(actual) === JSON.stringify(expected.styles);

            console.log(`${ok ? 'PASS' : 'FAIL'} ${expected.weapon} (tab ${style?.tabInterfaceId}, known=${style?.known})`);
            if (!ok) {
                console.log(`  expected: ${expected.styles.join(' | ')}`);
                console.log(`  actual:   ${actual.join(' | ')}`);
                passed = false;
            }

            // Every style must be selectable through the component we published.
            const last = (style?.styles.length ?? 1) - 1;
            await sdk.sendSetCombatStyle(last);
            await sleep(700);
            const selected = sdk.getState()?.combatStyle?.currentStyle;
            if (selected !== last) {
                console.log(`FAIL ${expected.weapon}: com_mode did not follow sendSetCombatStyle(${last}) (got ${selected})`);
                passed = false;
            }

            await bot.unequipItem(expected.weapon);
            await sleep(700);
        }

        const unarmed = sdk.getState()?.combatStyle;
        const unarmedStyles = describe(unarmed?.styles ?? []);
        const unarmedOk = unarmed?.tabInterfaceId === 5855 && JSON.stringify(unarmedStyles) === JSON.stringify(UNARMED);
        console.log(`${unarmedOk ? 'PASS' : 'FAIL'} Unarmed (tab ${unarmed?.tabInterfaceId})`);
        if (!unarmedOk) {
            console.log(`  actual: ${unarmedStyles.join(' | ')}`);
            passed = false;
        }
    } finally {
        await session.cleanup();
    }

    console.log(passed ? '\n=== ALL COMBAT STYLE CHECKS PASSED ===' : '\n=== COMBAT STYLE CHECKS FAILED ===');
    return passed;
}

const success = await main();
process.exit(success ? 0 : 1);
