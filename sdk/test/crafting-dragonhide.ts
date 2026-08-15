#!/usr/bin/env bun
/**
 * Green Dragonhide Crafting Test (SDK)
 * Test crafting with needle + thread + green dragonhide to make green d'hide body.
 *
 * Green d'hide body requires level 63 Crafting.
 * Green d'hide vambraces require level 57 Crafting.
 * Green d'hide chaps require level 60 Crafting.
 *
 * Success criteria: Green dragonhide item crafted + Crafting XP gained
 */

import { runTest, sleep } from './utils/test-runner';
import { Items, Locations } from './utils/save-generator';

runTest({
    name: 'Green Dragonhide Crafting Test (SDK)',
    saveConfig: {
        position: Locations.LUMBRIDGE_CASTLE,
        skills: { Crafting: 63 },  // Level 63 required for green d'hide body
        inventory: [
            { id: Items.NEEDLE, count: 1 },
            { id: Items.THREAD, count: 1 },
            { id: Items.GREEN_DRAGONHIDE, count: 3 },  // Need 3 for body
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Craft green dragonhide body with needle and thread');

    // Wait for state to fully load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    const initialXp = sdk.getSkill('Crafting')?.experience ?? 0;
    console.log(`Initial Crafting XP: ${initialXp}`);

    // Check inventory
    const needle = sdk.findInventoryItem(/needle/i);
    const thread = sdk.findInventoryItem(/thread/i);
    const dragonhide = sdk.findInventoryItem(/dragon/i);
    console.log(`Inventory: needle=${needle?.name ?? 'none'}, thread=${thread?.name ?? 'none'}, dragonhide=${dragonhide?.name ?? 'none'}`);

    if (!needle || !dragonhide) {
        console.log('FAILED: Missing needle or dragonhide in inventory');
        return false;
    }

    // Use needle on dragonhide to open crafting interface
    console.log('Using needle on dragonhide...');
    const useResult = await sdk.sendUseItemOnItem(needle.slot, dragonhide.slot);
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

            // Dragonhide crafting dialog has "Ok" buttons at indices 1,2,3 for body/vambraces/chaps
            // The text labels (Body, Vambraces, Chaps) are at indices 4,5,6
            // Click index 1 for body
            const okForBody = options.find(o => o.index === 1 && o.text === 'Ok');
            if (okForBody) {
                console.log(`  Clicking Ok button for body (index 1)`);
                await sdk.sendClickDialog(1);
            } else {
                // Fallback: try clicking the body label
                const bodyOpt = options.find(o => /body/i.test(o.text));
                if (bodyOpt) {
                    console.log(`  Selecting: ${bodyOpt.text} (index ${bodyOpt.index})`);
                    await sdk.sendClickDialog(bodyOpt.index);
                } else if (options.length > 0 && options[0]) {
                    console.log(`  Selecting first option: ${options[0].text}`);
                    await sdk.sendClickDialog(options[0].index);
                } else {
                    await sdk.sendClickDialog(0);
                }
            }
            await sleep(300);
            continue;
        }

        // Handle interface
        if (state.interface?.isOpen) {
            console.log(`Turn ${turn}: Interface open (id=${state.interface.interfaceId})`);
            console.log(`  Options: ${state.interface.options.map(o => `${o.index}:${o.text}`).join(', ') || '(none)'}`);

            // Dragonhide crafting interface - select body (likely first option with level)
            // For green d'hide: vambraces=57, chaps=60, body=63
            // Try array index 2 for body (highest level item)
            if (state.interface.options.length >= 3) {
                console.log(`  Selecting body (array index 2)`);
                await sdk.sendClickInterfaceOption(2);
            } else if (state.interface.options.length > 0) {
                console.log(`  Selecting first available option`);
                await sdk.sendClickInterfaceOption(0);
            }
            await sleep(300);
            continue;
        }

        // Check if dragonhide count decreased (consumed for crafting)
        const currentHides = sdk.getInventory().filter(i => /dragon/i.test(i.name));
        const startHides = 3;
        if (currentHides.length < startHides || currentHides.reduce((sum, h) => sum + h.count, 0) < startHides) {
            console.log(`Turn ${turn}: Dragonhide consumed, checking for XP...`);
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
