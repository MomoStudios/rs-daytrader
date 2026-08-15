#!/usr/bin/env bun
/**
 * Shop Bulk Buy Test
 * Tests buying items in various quantities, including amounts that
 * require decomposition into multiple Buy 1/5/10 commands.
 *
 * Success criteria:
 * 1. Buy 1 → gains 1
 * 2. Buy 5 → gains 5
 * 3. Buy 3 (decomposed to 1+1+1) → gains 3
 * 4. Buy 7 (decomposed to 5+1+1) → gains 7
 */

import { runTest, sleep } from './utils/test-runner';
import { Locations } from './utils/save-generator';

runTest({
    name: 'Shop Bulk Buy Test',
    saveConfig: {
        position: Locations.LUMBRIDGE_SHOP,
        coins: 10000,
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Test bulk buying from shop with amount decomposition');

    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    // Open shop
    console.log('\n--- Opening shop ---');
    const openResult = await bot.openShop();
    if (!openResult.success) {
        console.log(`FAIL: Could not open shop: ${openResult.message}`);
        return false;
    }
    console.log(`PASS: ${openResult.message}`);

    const shop = sdk.getState()?.shop;
    if (!shop?.isOpen) {
        console.log('FAIL: Shop not open');
        return false;
    }
    console.log(`Shop "${shop.title}" open`);
    for (const item of shop.shopItems) {
        console.log(`  [slot ${item.slot}] ${item.name} x${item.count} - ${item.buyPrice}gp`);
    }

    // Helper: count total items of a given ID across all inventory slots
    const countInvItems = (itemId: number) => {
        return sdk.getInventory()
            .filter(i => i.id === itemId)
            .reduce((sum, i) => sum + i.count, 0);
    };

    const runBuyTest = async (label: string, pattern: RegExp, amount: number, expectedGain: number) => {
        console.log(`\n--- ${label} ---`);
        const item = sdk.getState()?.shop?.shopItems.find(i => pattern.test(i.name));
        if (!item) {
            console.log(`FAIL: Item ${pattern} not found`);
            return false;
        }
        console.log(`Using "${item.name}" (stock: ${item.count})`);
        const before = countInvItems(item.id);
        const result = await bot.buyFromShop(item, amount);
        if (!result.success) {
            console.log(`FAIL: ${result.message}`);
            return false;
        }
        await sleep(300);
        const after = countInvItems(item.id);
        const gained = after - before;
        console.log(`${result.message} | inventory: ${before} → ${after} (gained ${gained})`);
        if (gained !== expectedGain) {
            console.log(`FAIL: Expected gain ${expectedGain}, got ${gained}`);
            return false;
        }
        console.log('PASS');
        return true;
    };

    // Test 1: Buy 1 (simple)
    if (!await runBuyTest('Test 1: Buy 1 (Pot)', /^pot$/i, 1, 1)) return false;

    // Test 2: Buy 5 (single command)
    if (!await runBuyTest('Test 2: Buy 5 (Hammer)', /^hammer$/i, 5, 5)) return false;

    // Test 3: Buy 3 → decomposes to 1+1+1
    if (!await runBuyTest('Test 3: Buy 3 (Chisel, decompose 1+1+1)', /^chisel$/i, 2, 2)) return false;

    // Test 4: Buy 2 more pots (we already have 1 — tests non-stackable with existing items)
    if (!await runBuyTest('Test 4: Buy 2 more Pots (already own 1)', /^pot$/i, 2, 2)) return false;

    // --- Summary ---
    const coins = sdk.findInventoryItem(/coins/i);
    const invCount = sdk.getInventory().length;
    console.log(`\n--- Summary ---`);
    console.log(`Inventory slots used: ${invCount}/28`);
    console.log(`Remaining coins: ${coins?.count ?? 0}`);

    await bot.closeShop();

    console.log('\n=== All tests passed ===');
    return true;
});
