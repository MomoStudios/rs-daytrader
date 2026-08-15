#!/usr/bin/env bun
/**
 * Oak Bow Fletching Test (SDK)
 * Tests that oak bows can be fletched using bot.fletchLogs().
 *
 * Oak fletching requirements:
 *   - Oak Shortbow: level 20
 *   - Oak Longbow: level 25
 */

import { runTest, sleep } from './utils/test-runner';
import { Items, Locations } from './utils/save-generator';

runTest({
    name: 'Oak Bow Fletching Test (SDK)',
    saveConfig: {
        position: Locations.LUMBRIDGE_CASTLE,
        skills: { Fletching: 25 },  // Level 25 needed for oak longbow
        inventory: [
            { id: Items.KNIFE, count: 1 },
            { id: Items.OAK_LOGS, count: 5 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Test oak bow fletching');

    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    const fletchingLevel = sdk.getSkill('Fletching')?.baseLevel ?? 1;
    console.log(`Fletching level: ${fletchingLevel}`);

    const knife = sdk.findInventoryItem(/knife/i);
    const oakLogs = sdk.findInventoryItem(/oak/i);
    if (!knife || !oakLogs) {
        console.log(`FAIL: Missing items - knife=${knife?.name ?? 'none'}, oak logs=${oakLogs?.name ?? 'none'}`);
        return false;
    }
    console.log(`Have ${knife.name} and ${oakLogs.name} x${oakLogs.count}`);

    // --- Test 1: Fletch Oak Shortbow ---
    console.log('\n--- Test 1: Fletch Oak Shortbow ---');
    const initialXp = sdk.getSkill('Fletching')?.experience ?? 0;

    const result1 = await bot.fletchLogs('oak short');
    console.log(`Result: ${result1.message}`);

    if (!result1.success) {
        console.log(`FAIL: ${result1.message}`);
        return false;
    }

    const oakShortbow = sdk.findInventoryItem(/oak.*shortbow/i);
    if (!oakShortbow) {
        console.log('FAIL: Oak shortbow not created');
        // Show what was created
        const inv = sdk.getInventory();
        console.log('Inventory:');
        for (const item of inv) {
            console.log(`  ${item.name} x${item.count}`);
        }
        return false;
    }
    console.log(`PASS: Created ${oakShortbow.name}`);

    // --- Test 2: Fletch Oak Longbow ---
    console.log('\n--- Test 2: Fletch Oak Longbow ---');

    const result2 = await bot.fletchLogs('oak long');
    console.log(`Result: ${result2.message}`);

    if (!result2.success) {
        console.log(`FAIL: ${result2.message}`);
        return false;
    }

    const oakLongbow = sdk.findInventoryItem(/oak.*longbow/i);
    if (!oakLongbow) {
        console.log('FAIL: Oak longbow not created');
        const inv = sdk.getInventory();
        console.log('Inventory:');
        for (const item of inv) {
            console.log(`  ${item.name} x${item.count}`);
        }
        return false;
    }
    console.log(`PASS: Created ${oakLongbow.name}`);

    // --- Summary ---
    const finalXp = sdk.getSkill('Fletching')?.experience ?? 0;
    console.log(`\nTotal XP gained: ${finalXp - initialXp}`);
    console.log('All oak bow tests passed!');

    return true;
});
