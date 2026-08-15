#!/usr/bin/env bun
/**
 * Shop Sell Rejection Test
 *
 * Tests the specific rejection scenario:
 * - Bob's Brilliant Axes only buys axes
 * - Trying to sell a non-axe item should fail with:
 *   "You can't sell this item to this shop."
 *
 * This test requires:
 * - The bot to have a non-axe item (dagger, pot, etc.) in inventory
 */

import { launchBotWithSDK, sleep, type SDKSession } from './utils/browser';
import type { ShopSellResult } from '../actions';

const BOT_NAME = process.env.BOT_NAME;
const BOBS_AXES = { x: 3231, z: 3203 }; // Bob's Brilliant Axes in Lumbridge
const LUMBRIDGE_GENERAL_STORE = { x: 3212, z: 3246 };

async function runTest(): Promise<boolean> {
    console.log('=== Shop Sell Rejection Test ===');
    console.log("Testing: Bob's Axes refuses to buy non-axe items");
    console.log('');

    let session: SDKSession | null = null;

    try {
        session = await launchBotWithSDK(BOT_NAME);
        const { sdk, bot } = session;
        console.log(`Bot '${session.botName}' ready!`);

        // Find a non-axe item to sell (dagger, pot, anything that's not an axe)
        let testItem = sdk.findInventoryItem(/dagger/i) ||
                       sdk.findInventoryItem(/pot$/i) ||
                       sdk.findInventoryItem(/bucket/i) ||
                       sdk.findInventoryItem(/sword/i);

        // If no suitable item, try to buy a pot from general store
        if (!testItem) {
            const coins = sdk.findInventoryItem(/coins/i);
            if (!coins || coins.count < 5) {
                console.log('ERROR: Need a non-axe item or coins to buy one');
                return false;
            }

            console.log('No test item found, buying a pot from general store...');
            await bot.walkTo(LUMBRIDGE_GENERAL_STORE.x, LUMBRIDGE_GENERAL_STORE.z);
            await sleep(500);

            const openResult = await bot.openShop(/shop\s*keeper/i);
            if (!openResult.success) {
                console.log(`Failed to open general store: ${openResult.message}`);
                return false;
            }

            const buyResult = await bot.buyFromShop(/pot$/i, 1);
            if (!buyResult.success) {
                console.log(`Failed to buy pot: ${buyResult.message}`);
                await sdk.sendCloseShop();
                return false;
            }
            console.log('Bought pot!');
            await sdk.sendCloseShop();
            await sleep(500);

            testItem = sdk.findInventoryItem(/pot$/i);
        }

        if (!testItem) {
            console.log('ERROR: Could not obtain a test item');
            return false;
        }

        console.log(`Test item: ${testItem.name} x${testItem.count}`);

        // Walk to Bob's Axes
        console.log("Walking to Bob's Brilliant Axes...");
        await bot.walkTo(BOBS_AXES.x, BOBS_AXES.z);
        await sleep(500);

        // Open Bob's shop
        const openResult = await bot.openShop(/bob/i);
        if (!openResult.success) {
            console.log(`Failed to open shop: ${openResult.message}`);
            return false;
        }
        console.log(`Opened: ${openResult.message}`);

        // Verify shop title
        const shopState = sdk.getState()?.shop;
        console.log(`Shop title: ${shopState?.title}`);

        // Try to sell the non-axe item
        console.log(`Attempting to sell ${testItem.name} (should be rejected)...`);
        const sellResult = await bot.sellToShop(testItem.name, 1) as ShopSellResult;

        console.log('Sell result:', JSON.stringify(sellResult, null, 2));

        // Verify rejection
        if (!sellResult.success && sellResult.rejected === true) {
            console.log('');
            console.log('SUCCESS! Shop correctly rejected the sale.');
            console.log(`Message: ${sellResult.message}`);
            await sdk.sendCloseShop();
            return true;
        }

        if (!sellResult.success) {
            console.log('');
            console.log('PARTIAL SUCCESS: Sale failed but rejected flag not set');
            console.log(`Message: ${sellResult.message}`);
            console.log(`Rejected: ${sellResult.rejected}`);
            await sdk.sendCloseShop();
            // This is still a success if the message indicates rejection
            return sellResult.message.toLowerCase().includes("doesn't buy") ||
                   sellResult.message.toLowerCase().includes("can't sell");
        }

        // If we get here, item was sold when it shouldn't have been
        console.log('');
        console.log(`FAILURE: ${testItem.name} was sold but it should have been rejected!`);
        console.log("Bob's Axes should only buy axes");
        await sdk.sendCloseShop();
        return false;

    } finally {
        if (session) {
            await session.cleanup();
        }
    }
}

runTest()
    .then(ok => {
        console.log(ok ? '\nPASSED' : '\nFAILED');
        process.exit(ok ? 0 : 1);
    })
    .catch(e => {
        console.error('Fatal:', e);
        process.exit(1);
    });
