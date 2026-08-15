#!/usr/bin/env bun
/**
 * Alchemy Test (SDK)
 * Cast Low Alchemy on items to gain Magic XP and coins.
 *
 * Low Alchemy requires:
 * - Level 21 Magic
 * - 3 Fire runes + 1 Nature rune per cast
 */

import { runTest, dismissDialog, sleep } from './utils/test-runner';
import { Items, Spells } from './utils/save-generator';

const MAX_TURNS = 100;

runTest({
    name: 'Alchemy Test (SDK)',
    saveConfig: {
        position: { x: 3222, z: 3218 },  // Lumbridge
        skills: { Magic: 21 },  // Need 21 for Low Alchemy
        inventory: [
            { id: Items.FIRE_RUNE, count: 3 },   // 1 cast needs 3 fire runes
            { id: Items.NATURE_RUNE, count: 1 },  // 1 cast needs 1 nature rune
            { id: Items.BRONZE_DAGGER, count: 1 },  // Items to alch (minimal)
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk }) => {
    console.log('Goal: Cast Low Alchemy on items to gain Magic XP');

    // Wait for state to fully load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    const initialLevel = sdk.getSkill('Magic')?.baseLevel ?? 1;
    const initialXp = sdk.getSkill('Magic')?.experience ?? 0;
    console.log(`Initial Magic: level ${initialLevel}, xp ${initialXp}`);

    // Check inventory
    const fireRunes = sdk.findInventoryItem(/fire rune/i);
    const natureRunes = sdk.findInventoryItem(/nature rune/i);
    const daggers = sdk.getInventory().filter(i => /bronze dagger/i.test(i.name));
    console.log(`Runes: fire=${fireRunes?.count ?? 0}, nature=${natureRunes?.count ?? 0}`);
    console.log(`Items to alch: ${daggers.length} bronze daggers`);

    let casts = 0;
    let lastCastTurn = 0;

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        // Check for success - XP gain
        const currentXp = sdk.getSkill('Magic')?.experience ?? 0;
        if (currentXp > initialXp) {
            console.log(`Turn ${turn}: SUCCESS - Magic XP gained (${initialXp} -> ${currentXp})`);
            return true;
        }

        // Handle dialogs
        if (await dismissDialog(sdk)) {
            continue;
        }

        // Progress logging
        if (turn % 20 === 0) {
            console.log(`Turn ${turn}: Magic xp ${currentXp}, casts ${casts}`);
        }

        // Check if we have runes
        const currentFire = sdk.findInventoryItem(/fire rune/i);
        const currentNature = sdk.findInventoryItem(/nature rune/i);
        if (!currentFire || currentFire.count < 3 || !currentNature || currentNature.count < 1) {
            console.log(`Turn ${turn}: Out of runes!`);
            break;
        }

        // Don't spam casts - wait between attempts (alchemy has a delay)
        if (turn - lastCastTurn < 5) {
            await sleep(300);
            continue;
        }

        // Find an item to alch (bronze daggers)
        const inventory = sdk.getInventory();
        const itemToAlch = inventory.find(i => /bronze dagger/i.test(i.name));

        if (itemToAlch) {
            console.log(`Turn ${turn}: Casting Low Alchemy on ${itemToAlch.name} in slot ${itemToAlch.slot}`);

            // Cast Low Alchemy on the item
            await sdk.sendSpellOnItem(itemToAlch.slot, Spells.LOW_ALCHEMY);
            casts++;
            lastCastTurn = turn;

            // Wait for spell animation
            await sleep(3000);
            continue;
        } else {
            console.log(`Turn ${turn}: No items left to alch!`);
            break;
        }
    }

    // Final results
    const finalXp = sdk.getSkill('Magic')?.experience ?? 0;
    const finalLevel = sdk.getSkill('Magic')?.baseLevel ?? 1;
    const coins = sdk.findInventoryItem(/coins/i);

    console.log(`\n=== Results ===`);
    console.log(`Magic: level ${initialLevel} -> ${finalLevel}, xp +${finalXp - initialXp}`);
    console.log(`Casts: ${casts}`);
    console.log(`Coins: ${coins?.count ?? 0}`);

    if (finalXp > initialXp) {
        console.log('SUCCESS: Gained Magic XP from alchemy!');
        return true;
    } else {
        console.log('FAILED: No XP gained');
        return false;
    }
});
