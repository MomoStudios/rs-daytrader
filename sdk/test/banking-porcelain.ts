#!/usr/bin/env bun
/**
 * Banking Porcelain Test (BotActions)
 * Tests the high-level banking methods in BotActions.
 *
 * This test validates the porcelain layer banking API that wraps
 * the low-level SDK banking methods with convenient, easy-to-use
 * methods like openBank(), depositItem(), withdrawItem(), closeBank().
 *
 * Success criteria:
 * 1. bot.openBank() opens the bank interface
 * 2. bot.depositItem() deposits an item from inventory
 * 3. bot.withdrawItem() withdraws an item from bank
 * 4. bot.closeBank() closes the bank interface
 */

import { runTest, sleep } from './utils/test-runner';
import { Items } from './utils/save-generator';

const AL_KHARID_BANK = { x: 3269, z: 3167 };

runTest({
    name: 'Banking Porcelain Test',
    saveConfig: {
        position: AL_KHARID_BANK,
        inventory: [
            { id: Items.BRONZE_SWORD, count: 1 },
            { id: Items.COINS, count: 100 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Test openBank(), depositItem(), withdrawItem(), closeBank()');

    // Wait for state to load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    // Check initial inventory
    const initialInv = sdk.getInventory();
    console.log(`Initial inventory: ${initialInv.map(i => `${i.name}(${i.count})`).join(', ')}`);

    const initialSword = sdk.findInventoryItem(/bronze sword/i);
    if (!initialSword) {
        console.log('FAILED: No bronze sword in initial inventory');
        return false;
    }
    console.log(`Bronze sword found at slot ${initialSword.slot}`);

    // =====================================
    // Step 1: Open bank using porcelain API
    // =====================================
    console.log('\n--- Step 1: Open bank with bot.openBank() ---');

    const openResult = await bot.openBank();
    console.log(`openBank() result: ${openResult.success ? 'SUCCESS' : 'FAILED'} - ${openResult.message}`);

    if (!openResult.success) {
        console.log('FAILED: Could not open bank');
        return false;
    }

    // Verify bank is open
    const stateAfterOpen = sdk.getState();
    if (!stateAfterOpen?.interface?.isOpen) {
        console.log('FAILED: Bank interface not open after openBank()');
        return false;
    }
    console.log(`Bank interface opened (interfaceId: ${stateAfterOpen.interface.interfaceId})`);

    // =====================================
    // Step 2: Deposit item using porcelain API
    // =====================================
    console.log('\n--- Step 2: Deposit bronze sword with bot.depositItem() ---');

    const depositResult = await bot.depositItem(/bronze sword/i);
    console.log(`depositItem() result: ${depositResult.success ? 'SUCCESS' : 'FAILED'} - ${depositResult.message}`);

    if (!depositResult.success) {
        console.log('FAILED: Could not deposit item');
        return false;
    }

    // Verify sword left inventory
    await sleep(300);
    const swordStillInInv = sdk.findInventoryItem(/bronze sword/i);
    if (swordStillInInv) {
        console.log('FAILED: Sword still in inventory after deposit');
        return false;
    }
    console.log('Sword deposited successfully (no longer in inventory)');

    // =====================================
    // Step 2b: Test deposit all (-1) with coins
    // =====================================
    console.log('\n--- Step 2b: Test deposit all coins with amount=-1 ---');

    const coinsBefore = sdk.findInventoryItem(/coins/i);
    if (!coinsBefore) {
        console.log('SKIPPED: No coins to test deposit all');
    } else {
        console.log(`Coins before deposit: ${coinsBefore.count}`);

        const depositAllResult = await bot.depositItem(/coins/i, -1);
        console.log(`depositItem(coins, -1) result: ${depositAllResult.success ? 'SUCCESS' : 'FAILED'} - ${depositAllResult.message}`);

        if (!depositAllResult.success) {
            console.log('FAILED: Could not deposit all coins');
            return false;
        }

        // Verify all coins left inventory
        await sleep(300);
        const coinsAfter = sdk.findInventoryItem(/coins/i);
        if (coinsAfter) {
            console.log(`FAILED: Still have ${coinsAfter.count} coins after deposit all`);
            return false;
        }
        console.log(`All ${coinsBefore.count} coins deposited successfully (amount=-1 works!)`);
    }

    // =====================================
    // Step 3: Withdraw item using porcelain API
    // =====================================
    console.log('\n--- Step 3: Withdraw bronze sword with bot.withdrawItem() ---');

    // The sword should be in bank slot 0
    const withdrawResult = await bot.withdrawItem(0);
    console.log(`withdrawItem() result: ${withdrawResult.success ? 'SUCCESS' : 'FAILED'} - ${withdrawResult.message}`);

    if (!withdrawResult.success) {
        console.log('FAILED: Could not withdraw item');
        return false;
    }

    // Verify sword returned to inventory
    await sleep(300);
    const swordReturned = sdk.findInventoryItem(/bronze sword/i);
    if (!swordReturned) {
        console.log('FAILED: Sword not in inventory after withdraw');
        return false;
    }
    console.log('Sword withdrawn successfully (back in inventory)');

    // =====================================
    // Step 4: Close bank using porcelain API
    // =====================================
    console.log('\n--- Step 4: Close bank with bot.closeBank() ---');

    const closeResult = await bot.closeBank();
    console.log(`closeBank() result: ${closeResult.success ? 'SUCCESS' : 'FAILED'} - ${closeResult.message}`);

    if (!closeResult.success) {
        console.log('FAILED: Could not close bank');
        return false;
    }

    // Verify bank is closed
    await sleep(300);
    const stateAfterClose = sdk.getState();
    if (stateAfterClose?.interface?.isOpen) {
        console.log('FAILED: Bank interface still open after closeBank()');
        return false;
    }
    console.log('Bank closed successfully');

    // =====================================
    // Final results
    // =====================================
    console.log('\n=== Results ===');
    console.log('openBank(): SUCCESS');
    console.log('depositItem(): SUCCESS');
    console.log('withdrawItem(): SUCCESS');
    console.log('closeBank(): SUCCESS');
    console.log('\nPASSED: All banking porcelain methods work correctly!');

    return true;
});
