#!/usr/bin/env bun
/**
 * Smithing Test (SDK)
 * Smelt copper + tin ore into bronze bars at Al-Kharid furnace.
 *
 * Uses a pre-configured save file that spawns at the furnace with ore ready.
 * This is an atomic test - mining is tested separately in mining.ts.
 */

import { runTest, sleep } from './utils/test-runner';
import { Items } from './utils/save-generator';

const MAX_TURNS = 200;
const FURNACE_AREA = { x: 3274, z: 3184 };

runTest({
    name: 'Smithing Test (SDK)',
    saveConfig: {
        position: FURNACE_AREA,
        skills: { Smithing: 1 },
        inventory: [
            { id: Items.COPPER_ORE, count: 1 },
            { id: Items.TIN_ORE, count: 1 },
        ],
    },
}, async ({ sdk, bot }) => {
    console.log('Goal: Smelt copper + tin ore into bronze bars');

    const initialLevel = sdk.getSkill('Smithing')?.baseLevel ?? 1;
    const initialXp = sdk.getSkill('Smithing')?.experience ?? 0;
    console.log(`Initial Smithing: level ${initialLevel}, xp ${initialXp}`);

    // Check inventory
    const copperCount = sdk.getInventory().filter(i => /copper ore/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);
    const tinCount = sdk.getInventory().filter(i => /tin ore/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);
    console.log(`Inventory: ${copperCount} copper ore, ${tinCount} tin ore`);

    if (copperCount < 1 || tinCount < 1) {
        console.log('ERROR: Missing ore in inventory');
        return false;
    }

    let barsSmelted = 0;

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const currentState = sdk.getState();

        // Handle dialogs/interfaces
        if (currentState?.dialog.isOpen) {
            // Look for "Bronze" option in smelting interface
            const options = currentState.dialog.options;
            if (turn === 1 || turn % 20 === 0) {
                console.log(`Turn ${turn}: Dialog options: ${options.map(o => o.text).join(', ')}`);
            }

            const bronzeOpt = options.findIndex(o => /bronze/i.test(o.text));
            if (bronzeOpt >= 0) {
                console.log(`Turn ${turn}: Selecting Bronze bar option (index ${bronzeOpt})`);
                await sdk.sendClickDialog(bronzeOpt);
            } else {
                await sdk.sendClickDialog(0);
            }
            await sleep(500);
            continue;
        }

        // Count bronze bars
        const barCount = sdk.getInventory().filter(i => /bronze bar/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);
        if (barCount > barsSmelted) {
            barsSmelted = barCount;
            console.log(`Turn ${turn}: Smelted ${barsSmelted} bronze bars!`);
        }

        // Check if we've run out of ore
        const copperLeft = sdk.getInventory().filter(i => /copper ore/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);
        const tinLeft = sdk.getInventory().filter(i => /tin ore/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);

        if (copperLeft === 0 || tinLeft === 0) {
            console.log(`Out of ore (copper: ${copperLeft}, tin: ${tinLeft})`);
            break;
        }

        // Progress logging
        if (turn % 30 === 0) {
            console.log(`Turn ${turn}: bars=${barsSmelted}, copper=${copperLeft}, tin=${tinLeft}`);
        }

        // Find and use furnace
        const allLocs = sdk.getNearbyLocs();
        if (turn === 1 || turn % 30 === 0) {
            console.log(`Turn ${turn} nearby locs:`);
            for (const loc of allLocs.slice(0, 10)) {
                const opts = loc.optionsWithIndex.map(o => o.text).join(', ');
                console.log(`  - ${loc.name} (${loc.x}, ${loc.z}): [${opts}]`);
            }
        }

        // Use ore on furnace
        const copperOre = sdk.findInventoryItem(/copper ore/i);
        if (copperOre) {
            const furnaceLoc = allLocs.find(loc =>
                /furnace/i.test(loc.name) || (loc.x === 3226 && loc.z === 3256)
            );

            if (furnaceLoc) {
                if (turn % 15 === 1) {
                    console.log(`Turn ${turn}: Using copper ore on ${furnaceLoc.name} at (${furnaceLoc.x}, ${furnaceLoc.z})`);
                }
                await sdk.sendUseItemOnLoc(copperOre.slot, furnaceLoc.x, furnaceLoc.z, furnaceLoc.id);
            } else {
                if (turn % 15 === 1) {
                    console.log(`Turn ${turn}: No furnace found, trying hardcoded coords (3274, 3186)`);
                }
                await sdk.sendUseItemOnLoc(copperOre.slot, 3274, 3186, 2966);
            }

            // Wait for smelting interface or bar creation
            try {
                await sdk.waitForCondition(state => {
                    if (state.dialog.isOpen) return true;
                    const newBars = state.inventory.filter(i => /bronze bar/i.test(i.name || '')).reduce((sum, i) => sum + i.count, 0);
                    if (newBars > barsSmelted) return true;
                    return false;
                }, 10000);
            } catch { /* timeout */ }
        } else {
            console.log(`Turn ${turn}: No copper ore found!`);
        }

        await sleep(400);
    }

    // Final results
    const finalBars = sdk.getInventory().filter(i => /bronze bar/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);
    const finalLevel = sdk.getSkill('Smithing')?.baseLevel ?? 1;
    const finalXp = sdk.getSkill('Smithing')?.experience ?? 0;

    console.log(`\n=== Results ===`);
    console.log(`Bronze bars smelted: ${finalBars}`);
    console.log(`Smithing: level ${initialLevel} -> ${finalLevel}, xp +${finalXp - initialXp}`);

    if (finalBars > 0) {
        console.log('SUCCESS: Smelted bronze bars!');
        return true;
    } else {
        console.log('FAILED: No bars smelted');
        return false;
    }
});
