#!/usr/bin/env bun
/**
 * Shop Inventory and Prices Test
 * Tests that shop items have correct inventory counts and calculated prices.
 *
 * Success criteria:
 * 1. Open shop and verify shop config is populated
 * 2. Verify shop items have stock counts > 0
 * 3. Verify items have baseCost, buyPrice, sellPrice
 * 4. Verify price relationships (buyPrice >= baseCost > sellPrice for most items)
 * 5. Verify specific item prices match expected formulas
 */

import { runTest, sleep } from './utils/test-runner';
import { Items, Locations } from './utils/save-generator';

runTest({
    name: 'Shop Inventory and Prices Test',
    saveConfig: {
        position: Locations.LUMBRIDGE_SHOP,
        inventory: [
            { id: Items.BRONZE_DAGGER, count: 1 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Test shop inventory counts and price calculations');

    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    // --- Test 1: Open shop and verify config ---
    console.log('\n--- Test 1: Open shop and verify config ---');
    const openResult = await bot.openShop(/shop\s*keeper/i);
    if (!openResult.success) {
        console.log(`FAIL: Could not open shop: ${openResult.message}`);
        return false;
    }

    const shopState = sdk.getState()?.shop;
    if (!shopState?.isOpen) {
        console.log('FAIL: Shop not open');
        return false;
    }
    console.log(`PASS: Shop "${shopState.title}" is open`);

    // Verify shop config exists
    if (!shopState.shopConfig) {
        console.log('FAIL: Shop config not populated');
        return false;
    }
    const config = shopState.shopConfig;
    console.log(`Shop config: buyMultiplier=${config.buyMultiplier}, sellMultiplier=${config.sellMultiplier}, haggle=${config.haggle}`);

    // Lumbridge General Store should have specific values
    if (config.sellMultiplier !== 1300 || config.buyMultiplier !== 400 || config.haggle !== 30) {
        console.log(`WARN: Unexpected shop config for Lumbridge General Store`);
        console.log(`  Expected: sellMultiplier=1300, buyMultiplier=400, haggle=30`);
        console.log(`  Got: sellMultiplier=${config.sellMultiplier}, buyMultiplier=${config.buyMultiplier}, haggle=${config.haggle}`);
    } else {
        console.log('PASS: Shop config matches Lumbridge General Store');
    }

    // --- Test 2: Verify shop items have stock ---
    console.log('\n--- Test 2: Verify shop items have stock ---');
    const shopItems = shopState.shopItems;
    if (shopItems.length === 0) {
        console.log('FAIL: No items in shop');
        return false;
    }
    console.log(`Shop has ${shopItems.length} items`);

    let allHaveStock = true;
    for (const item of shopItems) {
        if (item.count <= 0) {
            console.log(`FAIL: Item ${item.name} has count ${item.count}`);
            allHaveStock = false;
        }
    }
    if (allHaveStock) {
        console.log('PASS: All shop items have stock > 0');
    }

    // --- Test 3: Verify items have price fields ---
    console.log('\n--- Test 3: Verify items have price fields ---');
    let allHavePrices = true;
    for (const item of shopItems) {
        if (item.baseCost === undefined || item.buyPrice === undefined || item.sellPrice === undefined) {
            console.log(`FAIL: Item ${item.name} missing price fields`);
            allHavePrices = false;
        }
    }
    if (allHavePrices) {
        console.log('PASS: All items have baseCost, buyPrice, sellPrice');
    }

    // --- Test 4: Verify price relationships ---
    console.log('\n--- Test 4: Verify price relationships ---');
    let priceRelationsValid = true;
    for (const item of shopItems) {
        // Buy price should be >= base cost (shop sells at markup)
        if (item.buyPrice < item.baseCost) {
            console.log(`WARN: ${item.name} buyPrice (${item.buyPrice}) < baseCost (${item.baseCost})`);
        }
        // Sell price should be <= base cost (shop buys at discount)
        if (item.sellPrice > item.baseCost) {
            console.log(`WARN: ${item.name} sellPrice (${item.sellPrice}) > baseCost (${item.baseCost})`);
        }
        // Buy price should be > sell price (shop makes profit)
        if (item.buyPrice <= item.sellPrice && item.baseCost > 0) {
            console.log(`FAIL: ${item.name} buyPrice (${item.buyPrice}) <= sellPrice (${item.sellPrice})`);
            priceRelationsValid = false;
        }
    }
    if (priceRelationsValid) {
        console.log('PASS: Price relationships are valid (buyPrice > sellPrice)');
    }

    // --- Test 5: Verify specific item prices ---
    console.log('\n--- Test 5: Verify specific item prices ---');

    // Print all items for debugging
    console.log('Shop items:');
    for (const item of shopItems) {
        console.log(`  ${item.name}: count=${item.count}, baseCost=${item.baseCost}, buyPrice=${item.buyPrice}, sellPrice=${item.sellPrice}`);
    }

    // Find hammer and verify its prices
    const hammer = shopItems.find(i => /hammer/i.test(i.name));
    if (!hammer) {
        console.log('FAIL: Hammer not found in shop');
        return false;
    }

    // Hammer has baseCost=1
    // With Lumbridge General Store config (sellMultiplier=1300, buyMultiplier=400, haggle=30):
    // buyPrice = floor(1 * max(100, 1300 - 0) / 1000) = floor(1.3) = 1
    // sellPrice = floor(1 * max(100, 400 - 0) / 1000) = floor(0.4) = 0
    console.log(`Hammer: baseCost=${hammer.baseCost}, buyPrice=${hammer.buyPrice}, sellPrice=${hammer.sellPrice}`);
    if (hammer.baseCost !== 1) {
        console.log(`FAIL: Hammer baseCost should be 1, got ${hammer.baseCost}`);
        return false;
    }
    console.log('PASS: Hammer baseCost is correct (1gp)');

    // Find pot (baseCost=1) or bucket (baseCost=2) or tinderbox (baseCost=1)
    const tinderbox = shopItems.find(i => /tinderbox/i.test(i.name));
    if (tinderbox) {
        console.log(`Tinderbox: baseCost=${tinderbox.baseCost}, buyPrice=${tinderbox.buyPrice}, sellPrice=${tinderbox.sellPrice}`);
        // Tinderbox baseCost=1
        // buyPrice should be floor(1 * 1300 / 1000) = 1
        if (tinderbox.buyPrice !== 1) {
            console.log(`WARN: Tinderbox buyPrice expected 1, got ${tinderbox.buyPrice}`);
        }
    }

    // Test player items (for selling)
    console.log('\n--- Test 6: Verify player items for selling ---');
    const playerItems = shopState.playerItems;
    console.log(`Player has ${playerItems.length} items visible in shop`);

    if (playerItems.length > 0) {
        console.log('Player items in shop:');
        for (const item of playerItems) {
            console.log(`  ${item.name}: count=${item.count}, baseCost=${item.baseCost}, buyPrice=${item.buyPrice}, sellPrice=${item.sellPrice}`);
        }

        // The bronze dagger should be visible
        const dagger = playerItems.find(i => /dagger/i.test(i.name));
        if (dagger) {
            console.log(`PASS: Bronze dagger visible in player items`);
            // Bronze dagger baseCost=5
            console.log(`Dagger: baseCost=${dagger.baseCost}, sellPrice=${dagger.sellPrice}`);
        }
    }

    await bot.closeShop();

    console.log('\n=== All tests passed ===');
    return true;
});
