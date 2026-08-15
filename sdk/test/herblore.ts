#!/usr/bin/env bun
/**
 * Herblore Test (SDK)
 * Make a potion to gain Herblore XP.
 *
 * Tests the potion-making mechanic:
 * 1. Combine unfinished guam potion with eye of newt
 * 2. Verify attack potion is created
 * 3. Verify Herblore XP gained
 *
 * Herblore requires level 3 for attack potions.
 *
 * Success criteria: Herblore XP gained (potion made)
 */

import { runTest, sleep } from './utils/test-runner';
import { Items, Locations } from './utils/save-generator';

const MAX_TURNS = 100;

runTest({
    name: 'Herblore Test (SDK)',
    saveConfig: {
        position: Locations.LUMBRIDGE_CASTLE,
        skills: { Herblore: 3 },  // Level 3 required for attack potion
        inventory: [
            { id: Items.GUAM_POTION_UNF, count: 1 },
            { id: Items.EYE_OF_NEWT, count: 1 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk }) => {
    console.log('Goal: Make attack potion to gain Herblore XP');

    // Wait for state to fully load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    const initialLevel = sdk.getSkill('Herblore')?.baseLevel ?? 1;
    const initialXp = sdk.getSkill('Herblore')?.experience ?? 0;
    console.log(`Initial Herblore: level ${initialLevel}, xp ${initialXp}`);

    // Check inventory
    const unfPotion = sdk.findInventoryItem(/guam potion|unf/i);
    const eyeOfNewt = sdk.findInventoryItem(/eye of newt/i);
    console.log(`Inventory: unf potion=${unfPotion?.name ?? 'none'}, eye=${eyeOfNewt?.name ?? 'none'}`);

    if (!unfPotion || !eyeOfNewt) {
        console.log('FAILED: Missing ingredients');
        return false;
    }

    let potionAttempted = false;

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const currentState = sdk.getState();

        // Check for success - XP gain
        const currentXp = sdk.getSkill('Herblore')?.experience ?? 0;
        if (currentXp > initialXp) {
            console.log(`Turn ${turn}: SUCCESS - Herblore XP gained! (${initialXp} -> ${currentXp})`);
            return true;
        }

        // Check for potion in inventory
        const attackPotion = sdk.findInventoryItem(/attack potion/i);
        if (attackPotion) {
            console.log(`Turn ${turn}: SUCCESS - Attack potion created!`);
            return true;
        }

        // Handle interfaces (make-x dialogs)
        if (currentState?.interface.isOpen) {
            console.log(`Turn ${turn}: Interface open (id=${currentState.interface.interfaceId})`);
            console.log(`  Options: ${currentState.interface.options.map(o => `${o.index}:${o.text}`).join(', ') || 'none'}`);

            // Click first option to make the potion
            if (currentState.interface.options.length > 0 && currentState.interface.options[0]) {
                console.log(`  Clicking: ${currentState.interface.options[0].text}`);
                await sdk.sendClickInterfaceOption(0);
            }
            await sleep(500);
            continue;
        }

        // Handle dialogs
        if (currentState?.dialog.isOpen) {
            const options = currentState.dialog.options;
            console.log(`Turn ${turn}: Dialog: ${options.map(o => `${o.index}:${o.text}`).join(', ') || 'click to continue'}`);

            const makeOpt = options.find(o => /make|potion|yes/i.test(o.text));
            if (makeOpt) {
                await sdk.sendClickDialog(makeOpt.index);
            } else if (options.length > 0 && options[0]) {
                await sdk.sendClickDialog(options[0].index);
            } else {
                await sdk.sendClickDialog(0);
            }
            await sleep(500);
            continue;
        }

        // Combine ingredients
        const currentUnf = sdk.findInventoryItem(/guam potion|unf/i);
        const currentEye = sdk.findInventoryItem(/eye of newt/i);

        if (currentUnf && currentEye && !potionAttempted) {
            console.log(`Turn ${turn}: Combining ${currentUnf.name} with ${currentEye.name}`);
            await sdk.sendUseItemOnItem(currentEye.slot, currentUnf.slot);
            potionAttempted = true;

            // Wait for interface, dialog, or XP gain
            try {
                await sdk.waitForCondition(s => {
                    if (s.interface.isOpen) return true;
                    if (s.dialog.isOpen) return true;
                    const xp = s.skills.find(sk => sk.name === 'Herblore')?.experience ?? 0;
                    if (xp > initialXp) return true;
                    return false;
                }, 10000);
                potionAttempted = false;  // Reset to interact with interface
            } catch {
                console.log('No interface opened, retrying...');
                potionAttempted = false;
            }
            continue;
        }

        if (!currentUnf || !currentEye) {
            // Check final state
            const finalXp = sdk.getSkill('Herblore')?.experience ?? 0;
            if (finalXp > initialXp) {
                console.log(`Turn ${turn}: SUCCESS - XP gained!`);
                return true;
            }
            console.log(`Turn ${turn}: Ingredients used up`);
            break;
        }

        await sleep(400);
    }

    // Final check
    const finalXp = sdk.getSkill('Herblore')?.experience ?? 0;
    const finalLevel = sdk.getSkill('Herblore')?.baseLevel ?? 1;

    console.log(`\n=== Results ===`);
    console.log(`Herblore: level ${initialLevel} -> ${finalLevel}, xp +${finalXp - initialXp}`);

    if (finalXp > initialXp) {
        console.log('SUCCESS: Made potion!');
        return true;
    } else {
        console.log('FAILED: No XP gained');
        return false;
    }
});
