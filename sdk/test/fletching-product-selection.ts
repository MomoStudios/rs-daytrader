#!/usr/bin/env bun
/**
 * Fletching Product Selection Test (SDK)
 * Tests that non-default products (bows) can be selected in the fletching dialog.
 *
 * Regression test for the fletching product-selection bug:
 * - Clicking a product name in the fletching dialog should select it
 * - Then clicking "Ok" should craft the selected product
 *
 * Success criteria:
 * 1. Use knife on logs to open fletching dialog
 * 2. Click on "Short Bow" to select it
 * 3. Click "Ok" to confirm
 * 4. Verify short bow is created (not arrow shafts)
 */

import { runTest, sleep } from './utils/test-runner';
import { Items, Locations } from './utils/save-generator';

runTest({
    name: 'Fletching Product Selection Test (SDK)',
    saveConfig: {
        position: Locations.LUMBRIDGE_CASTLE,
        skills: { Fletching: 10 },  // Level 10 needed for short bow
        inventory: [
            { id: Items.KNIFE, count: 1 },
            { id: Items.LOGS, count: 5 },  // Multiple logs for testing
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Test fletching product selection (Short Bow instead of Arrow Shafts)');

    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    const state = sdk.getState();
    const fletchingLevel = sdk.getSkill('Fletching')?.baseLevel ?? 1;
    console.log(`Position: (${state?.player?.worldX}, ${state?.player?.worldZ})`);
    console.log(`Fletching level: ${fletchingLevel} (need level 5 for short bow, 10 for long bow)`);

    if (fletchingLevel < 5) {
        console.log('FAIL: Fletching level too low for bow making');
        return false;
    }

    const knife = sdk.findInventoryItem(/knife/i);
    const logs = sdk.findInventoryItem(/logs/i);
    if (!knife || !logs) {
        console.log(`FAIL: Missing items - knife=${knife?.name ?? 'none'}, logs=${logs?.name ?? 'none'}`);
        return false;
    }
    console.log(`Have ${knife.name} and ${logs.name} x${logs.count}`);

    const initialXp = sdk.getSkill('Fletching')?.experience ?? 0;

    // --- Test 1: Use bot.fletchLogs() with 'short bow' product ---
    console.log('\n--- Test 1: Use bot.fletchLogs() with Short Bow selection ---');
    console.log('Calling bot.fletchLogs("short bow")...');

    const fletchResult = await bot.fletchLogs('short bow');
    console.log(`Fletch result: ${fletchResult.message}`);
    console.log(`XP gained: ${fletchResult.xpGained ?? 0}`);

    if (!fletchResult.success) {
        console.log(`FAIL: bot.fletchLogs() returned failure: ${fletchResult.message}`);
        return false;
    }
    console.log('PASS: bot.fletchLogs() returned success');

    // --- Test 2: Verify XP was gained ---
    console.log('\n--- Test 2: Verify XP was gained ---');
    const finalXp = sdk.getSkill('Fletching')?.experience ?? 0;
    if (finalXp <= initialXp) {
        console.log('FAIL: No fletching XP gained');
        return false;
    }
    console.log(`PASS: XP gained (${initialXp} -> ${finalXp})`);

    // --- Test 3: Verify product created ---
    console.log('\n--- Test 3: Verify product created ---');
    await sleep(500);

    const shortbow = sdk.findInventoryItem(/shortbow/i);
    const longbow = sdk.findInventoryItem(/longbow/i);
    const arrowShafts = sdk.findInventoryItem(/arrow\s*shaft/i);

    console.log('Inventory check:');
    console.log(`  Short bow: ${shortbow ? shortbow.count : 'none'}`);
    console.log(`  Long bow: ${longbow ? longbow.count : 'none'}`);
    console.log(`  Arrow shafts: ${arrowShafts ? arrowShafts.count : 'none'}`);

    // Check if a bow was made (the new fletchLogs method should select short bow)
    if (shortbow || longbow) {
        console.log('PASS: A bow was successfully created!');
        return true;
    }

    if (arrowShafts) {
        console.log('FAIL: Arrow shafts were created instead of a bow');
        console.log('The bot.fletchLogs() product selection may need adjustment');
        return false;
    }

    console.log('WARN: Unknown product created, checking inventory...');
    const inv = sdk.getInventory();
    for (const item of inv) {
        console.log(`  ${item.name} x${item.count}`);
    }

    return false;
});
