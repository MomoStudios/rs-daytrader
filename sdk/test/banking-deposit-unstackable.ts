#!/usr/bin/env bun
/**
 * Banking Deposit Test - Unstackable Items
 * Tests depositing multiple non-stackable items (like bones) with amount=-1
 *
 * Question: Does sendBankDeposit(slot, -1) deposit ALL items of that type,
 * or just the one in that specific slot?
 */

import { runTest, sleep } from './utils/test-runner';
import { Items } from './utils/save-generator';

const AL_KHARID_BANK = { x: 3269, z: 3167 };

runTest({
    name: 'Banking Deposit Unstackable Test',
    saveConfig: {
        position: AL_KHARID_BANK,
        inventory: [
            // 2 bones - minimal to test if -1 deposits all or just one slot
            { id: Items.BONES, count: 1 },
            { id: Items.BONES, count: 1 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Test if deposit -1 works for non-stackable items (bones)');

    // Wait for state to load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    // Check initial inventory
    const initialInv = sdk.getInventory();
    const initialBones = initialInv.filter(i => /bones/i.test(i.name));
    console.log(`Initial inventory: ${initialInv.length} items`);
    console.log(`Bones in inventory: ${initialBones.length} (each in separate slot)`);

    if (initialBones.length < 2) {
        console.log(`FAILED: Expected at least 2 bones, got ${initialBones.length}`);
        return false;
    }

    // Open bank
    console.log('\n--- Opening bank ---');
    const openResult = await bot.openBank();
    if (!openResult.success) {
        console.log(`FAILED: Could not open bank: ${openResult.message}`);
        return false;
    }
    console.log('Bank opened');

    // Try to deposit all bones with -1
    console.log('\n--- Testing depositItem(bones, -1) ---');
    const firstBone = initialBones[0];
    if (!firstBone) {
        console.log('FAILED: No bones found in inventory');
        return false;
    }
    console.log(`Depositing from slot ${firstBone.slot} with amount=-1...`);

    const depositResult = await bot.depositItem(/bones/i, -1);
    console.log(`Result: ${depositResult.success ? 'SUCCESS' : 'FAILED'} - ${depositResult.message}`);

    await sleep(500);

    // Check how many bones remain
    const afterInv = sdk.getInventory();
    const afterBones = afterInv.filter(i => /bones/i.test(i.name));
    console.log(`\nBones remaining in inventory: ${afterBones.length}`);

    if (afterBones.length === 0) {
        console.log('\nRESULT: deposit -1 deposits ALL items of that type (even non-stackable)!');
    } else if (afterBones.length === initialBones.length - 1) {
        console.log('\nRESULT: deposit -1 only deposits from ONE slot for non-stackable items');
        console.log('You need to loop through all slots to deposit multiple non-stackable items');
    } else {
        console.log(`\nRESULT: Unexpected - deposited ${initialBones.length - afterBones.length} bones`);
    }

    // Close bank
    await bot.closeBank();

    // Test passes either way - we just want to know the behavior
    console.log('\n=== Test Complete ===');
    return true;
});
