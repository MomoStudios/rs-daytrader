#!/usr/bin/env bun
/**
 * Crafting Test (SDK)
 * Test crafting with needle + thread + leather to make leather gloves.
 *
 * Tests the crafting interface flow:
 * 1. Use needle on leather
 * 2. Handle the crafting interface that appears
 * 3. Verify crafted item appears in inventory + XP gained
 *
 * Success criteria: Leather item crafted + Crafting XP gained
 */

import { runTest, sleep } from './utils/test-runner';
import { Items, Locations } from './utils/save-generator';

runTest({
    name: 'Crafting Test (SDK)',
    saveConfig: {
        position: Locations.LUMBRIDGE_CASTLE,
        skills: { Crafting: 1 },
        inventory: [
            { id: Items.NEEDLE, count: 1 },
            { id: Items.THREAD, count: 1 },
            { id: Items.LEATHER, count: 1 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Craft leather item with needle and thread');

    // Wait for state to fully load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    const initialXp = sdk.getSkill('Crafting')?.experience ?? 0;
    console.log(`Initial Crafting XP: ${initialXp}`);

    // Check inventory
    const needle = sdk.findInventoryItem(/needle/i);
    const thread = sdk.findInventoryItem(/thread/i);
    const leather = sdk.findInventoryItem(/leather/i);
    console.log(`Inventory: needle=${needle?.name ?? 'none'}, thread=${thread?.name ?? 'none'}, leather=${leather?.name ?? 'none'}`);

    if (!needle || !leather) {
        console.log('FAILED: Missing needle or leather in inventory');
        return false;
    }

    // Use high-level BotActions method to craft leather gloves
    console.log('Using bot.craftLeather() to craft gloves...');
    const result = await bot.craftLeather('gloves');

    console.log('\n=== Results ===');
    console.log(`Result: ${result.message}`);

    if (result.success) {
        console.log(`XP Gained: +${result.xpGained}`);
        console.log(`Items Crafted: ${result.itemsCrafted}`);
        console.log('SUCCESS: Crafted leather item!');
        return true;
    } else {
        console.log(`FAILED: ${result.message} (reason: ${result.reason})`);
        return false;
    }
});
