#!/usr/bin/env bun
/**
 * Shop Sell Unstackable Items Test
 *
 * Tests selling multiple unstackable items (like shortbows) where each
 * item has count=1 but shares the same item ID.
 *
 * This reproduces an issue where sellToShop returns success:false
 * even though the sale succeeds, because the count-based success
 * detection doesn't work for unstackable items.
 *
 * Success criteria:
 * 1. Open shop
 * 2. Sell multiple shortbows one at a time
 * 3. Verify each sale returns success:true
 * 4. Verify GP increases after each sale
 */

import { runTest, sleep } from './utils/test-runner';
import { Items, Locations } from './utils/save-generator';

// Shortbow item ID
const SHORTBOW_ID = 841;

runTest({
    name: 'Shop Sell Unstackable Items Test',
    saveConfig: {
        position: Locations.LUMBRIDGE_SHOP,
        inventory: [
            // 5 shortbows - each is a separate item with count=1
            { id: SHORTBOW_ID, count: 1 },
            { id: SHORTBOW_ID, count: 1 },
            { id: SHORTBOW_ID, count: 1 },
            { id: SHORTBOW_ID, count: 1 },
            { id: SHORTBOW_ID, count: 1 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Test selling multiple unstackable items (shortbows)');

    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    // Count initial shortbows
    const initialBows = sdk.getState()?.inventory.filter(i => i.id === SHORTBOW_ID) || [];
    console.log(`Starting with ${initialBows.length} shortbows in inventory`);

    if (initialBows.length !== 5) {
        console.log(`FAIL: Expected 5 shortbows, got ${initialBows.length}`);
        return false;
    }

    // --- Test 1: Open shop ---
    console.log('\n--- Test 1: Open shop ---');
    const openResult = await bot.openShop(/shop\s*keeper/i);
    if (!openResult.success) {
        console.log(`FAIL: Could not open shop: ${openResult.message}`);
        return false;
    }
    console.log(`PASS: ${openResult.message}`);

    // Verify shop is open
    const shopState = sdk.getState()?.shop;
    if (!shopState?.isOpen) {
        console.log('FAIL: Shop not open');
        return false;
    }

    // Count shortbows in player shop items
    const playerBows = shopState.playerItems.filter(i => i.id === SHORTBOW_ID);
    console.log(`Shop sees ${playerBows.length} shortbows available to sell`);

    // --- Test 2: Get initial coins ---
    console.log('\n--- Test 2: Check initial coins ---');
    let coins = sdk.findInventoryItem(/coins/i);
    let gpBefore = coins?.count ?? 0;
    console.log(`Starting GP: ${gpBefore}`);

    // --- Test 3: Sell shortbows one at a time ---
    console.log('\n--- Test 3: Sell shortbows one at a time ---');
    let successCount = 0;
    let failCount = 0;
    let totalGpGained = 0;

    for (let i = 0; i < 5; i++) {
        const state = sdk.getState();
        if (!state?.shop.isOpen) {
            console.log('FAIL: Shop closed unexpectedly');
            return false;
        }

        const shortbow = state.shop.playerItems.find(item => item.id === SHORTBOW_ID);
        if (!shortbow) {
            console.log(`INFO: No more shortbows to sell after ${i} sales`);
            break;
        }

        const gpBeforeSale = sdk.findInventoryItem(/coins/i)?.count ?? 0;
        console.log(`\nSelling shortbow #${i + 1} (slot ${shortbow.slot})...`);

        const sellResult = await bot.sellToShop(shortbow, 1);
        await sleep(200);

        const gpAfterSale = sdk.findInventoryItem(/coins/i)?.count ?? 0;
        const gpGained = gpAfterSale - gpBeforeSale;
        totalGpGained += gpGained;

        console.log(`  Result: success=${sellResult.success}, message="${sellResult.message}"`);
        console.log(`  GP change: ${gpBeforeSale} -> ${gpAfterSale} (+${gpGained})`);

        if (sellResult.success) {
            successCount++;
        } else {
            failCount++;
            // Check if GP actually increased (sale worked despite false return)
            if (gpGained > 0) {
                console.log(`  WARNING: success=false but GP increased! This is a bug.`);
            }
        }
    }

    // --- Test 4: Summary ---
    console.log('\n--- Test 4: Summary ---');
    console.log(`Successful sells: ${successCount}`);
    console.log(`Failed sells: ${failCount}`);
    console.log(`Total GP gained: ${totalGpGained}`);

    // Check remaining shortbows
    const remainingBows = sdk.getState()?.inventory.filter(i => i.id === SHORTBOW_ID) || [];
    console.log(`Remaining shortbows: ${remainingBows.length}`);

    await bot.closeShop();

    // Determine test result
    if (failCount > 0 && totalGpGained > 0) {
        console.log('\nFAIL: sellToShop returned false but GP was gained.');
        console.log('This indicates the bug with unstackable item detection.');
        return false;
    }

    if (successCount === 5 && remainingBows.length === 0) {
        console.log('\nPASS: All 5 shortbows sold successfully');
        return true;
    }

    console.log('\nFAIL: Unexpected result');
    return false;
});
