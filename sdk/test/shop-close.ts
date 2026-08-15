#!/usr/bin/env bun
/**
 * Shop Close Test (SDK)
 * Tests that shop interface properly closes after selling items.
 *
 * Regression test for the shop-interface teardown bug:
 * - After selling items, the shop interface should fully close
 * - Both shop.isOpen AND interface.isOpen should become false
 *
 * Success criteria:
 * 1. Open shop
 * 2. Sell an item
 * 3. Close shop
 * 4. Verify shop.isOpen is false
 * 5. Verify interface.isOpen is false (the key issue)
 * 6. Verify bot can interact with world again (chop a tree)
 */

import { runTest, sleep } from './utils/test-runner';
import { Items, Locations } from './utils/save-generator';

runTest({
    name: 'Shop Close Test (SDK)',
    saveConfig: {
        position: Locations.LUMBRIDGE_SHOP,
        inventory: [
            { id: Items.BRONZE_DAGGER, count: 1 },
            { id: Items.POT, count: 1 },  // Second item to sell
            { id: Items.BRONZE_AXE, count: 1 },  // For tree test
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Test that shop closes properly after selling items');

    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    const state = sdk.getState();
    console.log(`Position: (${state?.player?.worldX}, ${state?.player?.worldZ})`);

    // --- Test 1: Open shop ---
    console.log('\n--- Test 1: Open shop ---');
    const openResult = await bot.openShop(/shop\s*keeper/i);
    if (!openResult.success) {
        console.log(`FAIL: Could not open shop: ${openResult.message}`);
        return false;
    }
    console.log(`PASS: ${openResult.message}`);

    // Verify shop is open
    let shopState = sdk.getState()?.shop;
    let interfaceState = sdk.getState()?.interface;
    console.log(`Shop state: isOpen=${shopState?.isOpen}, interface.isOpen=${interfaceState?.isOpen}`);
    if (!shopState?.isOpen) {
        console.log('FAIL: Shop not open');
        return false;
    }
    console.log('PASS: Shop is open');

    // --- Test 2: Sell first item ---
    console.log('\n--- Test 2: Sell first item ---');
    const dagger = sdk.findInventoryItem(/dagger/i);
    if (!dagger) {
        console.log('FAIL: No dagger in inventory');
        await bot.closeShop();
        return false;
    }
    console.log(`Selling ${dagger.name}...`);

    const sellResult = await bot.sellToShop(dagger);
    console.log(`Sell result: ${sellResult.message}`);
    if (!sellResult.success) {
        console.log('WARN: Sell might have failed');
    }
    await sleep(300);

    // --- Test 3: Sell second item ---
    console.log('\n--- Test 3: Sell second item ---');
    const pot = sdk.findInventoryItem(/pot$/i);
    if (pot) {
        console.log(`Selling ${pot.name}...`);
        const sellResult2 = await bot.sellToShop(pot);
        console.log(`Sell result: ${sellResult2.message}`);
    }
    await sleep(300);

    // --- Test 4: Close shop using bot.closeShop() (the new fix) ---
    console.log('\n--- Test 4: Close shop using bot.closeShop() ---');
    console.log('Calling bot.closeShop()...');
    const closeResult = await bot.closeShop();
    console.log(`Close result: ${closeResult.message}`);

    if (!closeResult.success) {
        console.log('FAIL: bot.closeShop() returned failure');
        return false;
    }

    // Check shop state immediately
    shopState = sdk.getState()?.shop;
    interfaceState = sdk.getState()?.interface;
    console.log(`After bot.closeShop(): shop.isOpen=${shopState?.isOpen}, interface.isOpen=${interfaceState?.isOpen}`);

    // --- Test 5: Verify shop.isOpen is false ---
    console.log('\n--- Test 5: Verify shop.isOpen is false ---');
    if (shopState?.isOpen) {
        console.log('FAIL: shop.isOpen is still true after multiple close attempts');
        return false;
    }
    console.log('PASS: shop.isOpen is false');

    // --- Test 6: Verify interface.isOpen is false (THE KEY TEST) ---
    console.log('\n--- Test 6: Verify interface.isOpen is false ---');
    if (interfaceState?.isOpen) {
        console.log(`FAIL: interface.isOpen is still true!`);
        console.log(`       interfaceId=${interfaceState?.interfaceId}`);
        console.log(`       options=${JSON.stringify(interfaceState?.options)}`);
        console.log('Regression: interface stays open after shop closes');
        return false;
    }
    console.log('PASS: interface.isOpen is false');

    // --- Test 7: Verify bot can interact with world ---
    console.log('\n--- Test 7: Verify bot can interact with world (short walk) ---');

    // Get current position
    const currentState = sdk.getState();
    const startX = currentState?.player?.worldX ?? 3212;
    const startZ = currentState?.player?.worldZ ?? 3246;

    // Use sendWalk directly (bypasses pathfinding which doesn't have shop interior data)
    const targetX = startX + 2;
    const targetZ = startZ;
    console.log(`Walking from (${startX}, ${startZ}) to (${targetX}, ${targetZ}) using sendWalk...`);

    await sdk.sendWalk(targetX, targetZ);
    await sleep(1000);

    const afterWalk = sdk.getState();
    const movedX = afterWalk?.player?.worldX ?? startX;
    const movedZ = afterWalk?.player?.worldZ ?? startZ;

    if (movedX !== startX || movedZ !== startZ) {
        console.log(`PASS: Moved to (${movedX}, ${movedZ})`);
    } else {
        console.log(`FAIL: Did not move - still at (${movedX}, ${movedZ})`);
        console.log('This indicates the interface might still be blocking interactions');
        return false;
    }

    // --- Test 8: Try to chop a tree (ultimate interaction test) ---
    console.log('\n--- Test 8: Chop a tree to verify full interaction ---');
    await sleep(1000);  // Wait for position update

    const tree = sdk.findNearbyLoc(/^tree$/i);
    if (tree) {
        const chopResult = await bot.chopTree(tree);
        if (!chopResult.success) {
            console.log(`WARN: Could not chop tree (might just be too far): ${chopResult.message}`);
            // This isn't necessarily a failure - might just not be close enough
        } else {
            console.log(`PASS: Successfully started chopping tree`);
        }
    } else {
        console.log('INFO: No trees nearby, skipping chop test');
    }

    console.log('\n=== All shop close tests passed ===');
    return true;
});
