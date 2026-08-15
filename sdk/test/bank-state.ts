#!/usr/bin/env bun
/**
 * Bank State API Test
 * Test that bank contents are exposed via sdk.getState().bank
 *
 * Success criteria:
 * 1. Open bank interface
 * 2. Verify bank.isOpen is true
 * 3. Deposit items and verify they appear in bank.items
 * 4. Test helper methods: getBankItems(), findBankItem(), isBankOpen()
 */

import { runTest, sleep } from './utils/test-runner';
import { Items } from './utils/save-generator';

const VARROCK_BANK = { x: 3185, z: 3436 };

runTest({
    name: 'Bank State API Test',
    saveConfig: {
        position: VARROCK_BANK,
        inventory: [
            { id: Items.BRONZE_SWORD, count: 1 },
            { id: Items.LOGS, count: 5 },
            { id: Items.COINS, count: 100 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Test bank state API (bank.isOpen, bank.items)');

    // Wait for state to fully load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    // Check initial state - bank should be closed
    console.log('\n--- Step 1: Verify bank is initially closed ---');

    let state = sdk.getState();
    console.log(`bank.isOpen: ${state?.bank?.isOpen}`);
    console.log(`sdk.isBankOpen(): ${sdk.isBankOpen()}`);
    console.log(`bank.items: ${JSON.stringify(state?.bank?.items || [])}`);

    if (state?.bank?.isOpen) {
        console.log('FAILED: Bank should be closed initially');
        return false;
    }
    console.log('PASS: Bank is closed initially');

    // Open the bank
    console.log('\n--- Step 2: Open bank ---');

    const openResult = await bot.openBank();
    if (!openResult.success) {
        console.log(`FAILED: Could not open bank - ${openResult.message}`);
        return false;
    }
    console.log('Bank opened successfully');
    await sleep(500);

    // Verify bank state shows open
    console.log('\n--- Step 3: Verify bank.isOpen is true ---');

    state = sdk.getState();
    console.log(`bank.isOpen: ${state?.bank?.isOpen}`);
    console.log(`sdk.isBankOpen(): ${sdk.isBankOpen()}`);

    if (!state?.bank?.isOpen) {
        console.log('FAILED: bank.isOpen should be true after opening');
        return false;
    }
    if (!sdk.isBankOpen()) {
        console.log('FAILED: sdk.isBankOpen() should return true');
        return false;
    }
    console.log('PASS: Bank state shows open');

    // Deposit items
    console.log('\n--- Step 4: Deposit items and verify bank.items ---');

    // Deposit the bronze sword
    const depositResult = await bot.depositItem(/bronze sword/i, 1);
    console.log(`Deposit sword result: ${depositResult.success} - ${depositResult.message}`);
    await sleep(300);

    // Deposit the logs
    const depositLogs = await bot.depositItem(/logs/i, -1); // deposit all
    console.log(`Deposit logs result: ${depositLogs.success} - ${depositLogs.message}`);
    await sleep(300);

    // Check bank contents
    state = sdk.getState();
    const bankItems = state?.bank?.items || [];
    console.log(`\nBank items (${bankItems.length}):`);
    for (const item of bankItems) {
        console.log(`  Slot ${item.slot}: ${item.name} x${item.count} (id: ${item.id})`);
    }

    // Verify items are in bank
    const swordInBank = bankItems.some(i => /bronze sword/i.test(i.name));
    const logsInBank = bankItems.some(i => /^logs$/i.test(i.name));

    console.log(`\nSword in bank: ${swordInBank}`);
    console.log(`Logs in bank: ${logsInBank}`);

    if (!swordInBank) {
        console.log('FAILED: Bronze sword should be in bank.items');
        return false;
    }
    if (!logsInBank) {
        console.log('FAILED: Logs should be in bank.items');
        return false;
    }
    console.log('PASS: Deposited items appear in bank.items');

    // Test helper methods
    console.log('\n--- Step 5: Test SDK helper methods ---');

    // Test getBankItems()
    const allBankItems = sdk.getBankItems();
    console.log(`sdk.getBankItems() returned ${allBankItems.length} items`);

    // Test findBankItem()
    const foundSword = sdk.findBankItem(/bronze sword/i);
    console.log(`sdk.findBankItem(/bronze sword/i): ${foundSword ? `Found at slot ${foundSword.slot}` : 'Not found'}`);

    const foundLogs = sdk.findBankItem(/^logs$/i);
    console.log(`sdk.findBankItem(/^logs$/i): ${foundLogs ? `Found ${foundLogs.count}x at slot ${foundLogs.slot}` : 'Not found'}`);

    // Test getBankItem() by slot
    if (foundSword) {
        const itemBySlot = sdk.getBankItem(foundSword.slot);
        console.log(`sdk.getBankItem(${foundSword.slot}): ${itemBySlot?.name || 'null'}`);

        if (!itemBySlot || itemBySlot.name !== foundSword.name) {
            console.log('FAILED: getBankItem should return item at slot');
            return false;
        }
    }

    if (!foundSword || !foundLogs) {
        console.log('FAILED: Helper methods should find deposited items');
        return false;
    }
    console.log('PASS: SDK helper methods work correctly');

    // Close bank and verify state updates
    console.log('\n--- Step 6: Close bank and verify state ---');

    await bot.closeBank();
    await sleep(500);

    state = sdk.getState();
    console.log(`bank.isOpen after close: ${state?.bank?.isOpen}`);
    console.log(`sdk.isBankOpen() after close: ${sdk.isBankOpen()}`);

    if (state?.bank?.isOpen) {
        console.log('FAILED: bank.isOpen should be false after closing');
        return false;
    }
    console.log('PASS: Bank state shows closed after closing');

    // Verify helper methods return empty when bank is closed
    const itemsWhenClosed = sdk.getBankItems();
    const findWhenClosed = sdk.findBankItem(/bronze sword/i);
    console.log(`\ngetBankItems() when closed: ${itemsWhenClosed.length} items`);
    console.log(`findBankItem() when closed: ${findWhenClosed}`);

    console.log('\n=== Results ===');
    console.log('All bank state API tests passed!');
    return true;
});
