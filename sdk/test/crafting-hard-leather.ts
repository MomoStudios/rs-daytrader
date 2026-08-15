#!/usr/bin/env bun
/**
 * Hard Leather Crafting Test (SDK)
 * Test crafting with needle + thread + hard leather to make hard leather body.
 *
 * Hard leather body requires level 28 Crafting.
 *
 * Success criteria: Hard leather item crafted + Crafting XP gained
 */

import { runTest, sleep } from './utils/test-runner';
import { Items, Locations } from './utils/save-generator';

runTest({
    name: 'Hard Leather Crafting Test (SDK)',
    saveConfig: {
        position: Locations.LUMBRIDGE_CASTLE,
        skills: { Crafting: 28 },  // Level 28 required for hard leather body
        inventory: [
            { id: Items.NEEDLE, count: 1 },
            { id: Items.THREAD, count: 1 },
            { id: Items.HARD_LEATHER, count: 1 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Craft hard leather body with needle and thread');

    // Wait for state to fully load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    const initialXp = sdk.getSkill('Crafting')?.experience ?? 0;
    console.log(`Initial Crafting XP: ${initialXp}`);

    // Check inventory
    const needle = sdk.findInventoryItem(/needle/i);
    const thread = sdk.findInventoryItem(/thread/i);
    const hardLeather = sdk.findInventoryItem(/hard leather/i);
    console.log(`Inventory: needle=${needle?.name ?? 'none'}, thread=${thread?.name ?? 'none'}, hard leather=${hardLeather?.name ?? 'none'}`);

    if (!needle || !hardLeather) {
        console.log('FAILED: Missing needle or hard leather in inventory');
        return false;
    }

    // Use needle on hard leather to open crafting interface
    console.log('Using needle on hard leather...');
    const useResult = await sdk.sendUseItemOnItem(needle.slot, hardLeather.slot);
    console.log(`Use item result: ${useResult.success ? 'success' : useResult.message}`);

    // Wait for interface/dialog with debug logging
    const MAX_TURNS = 100;
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const state = sdk.getState();
        if (!state) continue;

        // Check for XP gain (success!)
        const currentXp = sdk.getSkill('Crafting')?.experience ?? 0;
        if (currentXp > initialXp) {
            console.log(`Turn ${turn}: SUCCESS - Crafting XP gained (${initialXp} -> ${currentXp})`);
            return true;
        }

        // Handle dialog
        if (state.dialog.isOpen) {
            const options = state.dialog.options;
            console.log(`Turn ${turn}: Dialog open - text: "${state.dialog.text}"`);
            console.log(`  Options: ${options.map(o => `${o.index}:${o.text}`).join(', ') || '(none)'}`);

            const craftOpt = options.find(o => /body|craft|make|leather/i.test(o.text));
            if (craftOpt) {
                console.log(`  Selecting: ${craftOpt.text}`);
                await sdk.sendClickDialog(craftOpt.index);
            } else if (options.length > 0 && options[0]) {
                console.log(`  Selecting first option: ${options[0].text}`);
                await sdk.sendClickDialog(options[0].index);
            } else {
                await sdk.sendClickDialog(0);
            }
            await sleep(300);
            continue;
        }

        // Handle interface
        if (state.interface?.isOpen) {
            console.log(`Turn ${turn}: Interface open (id=${state.interface.interfaceId})`);
            console.log(`  Options: ${state.interface.options.map(o => `${o.index}:${o.text}`).join(', ') || '(none)'}`);

            // Hard leather crafting - try first option (hard leather body)
            // Array index 0 = option.index 1 = first item (hard leather body)
            if (state.interface.options.length > 0) {
                console.log(`  Selecting first option (array index 0)`);
                await sdk.sendClickInterfaceOption(0);
            }
            await sleep(300);
            continue;
        }

        // Check if hard leather is consumed
        const currentLeather = sdk.findInventoryItem(/hard leather/i);
        if (!currentLeather) {
            console.log(`Turn ${turn}: Hard leather consumed, checking for XP...`);
            await sleep(500);
            const finalXp = sdk.getSkill('Crafting')?.experience ?? 0;
            if (finalXp > initialXp) {
                console.log(`SUCCESS - XP gained: ${finalXp - initialXp}`);
                return true;
            }
        }

        // Periodic status
        if (turn % 20 === 0) {
            console.log(`Turn ${turn}: Waiting... (dialog=${state.dialog.isOpen}, interface=${state.interface?.isOpen})`);
        }

        await sleep(200);
    }

    console.log('\n=== Results ===');
    console.log('FAILED: Timeout - crafting did not complete');
    return false;
});
