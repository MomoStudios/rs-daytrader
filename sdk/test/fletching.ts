#!/usr/bin/env bun
/**
 * Fletching Test (BotActions)
 * Use knife on logs to make arrow shafts and gain Fletching XP.
 *
 * Success criteria: Fletching XP gained (arrow shafts created)
 */

import { runTest, sleep } from './utils/test-runner';
import { Items, Locations } from './utils/save-generator';

runTest({
    name: 'Fletching Test (BotActions)',
    saveConfig: {
        position: Locations.LUMBRIDGE_CASTLE,
        inventory: [
            { id: Items.KNIFE, count: 1 },
            { id: Items.LOGS, count: 5 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot}) => {
    console.log('Goal: Use knife on logs to gain Fletching XP');

    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    const initialXp = sdk.getSkill('Fletching')?.experience ?? 0;
    console.log(`Initial Fletching XP: ${initialXp}`);

    const knife = sdk.findInventoryItem(/knife/i);
    const logs = sdk.findInventoryItem(/logs/i);
    if (!knife || !logs) {
        console.log(`ERROR: Missing items - knife=${knife?.name ?? 'none'}, logs=${logs?.name ?? 'none'}`);
        return false;
    }
    console.log(`Have ${knife.name} and ${logs.name} x${logs.count}`);

    // Use high-level BotActions for fletching
    console.log('Using bot.fletchLogs() to create arrow shafts...');
    const result = await bot.fletchLogs('arrow shaft');

    if (!result.success) {
        console.log(`ERROR: Fletching failed - ${result.message}`);
        return false;
    }

    const finalXp = sdk.getSkill('Fletching')?.experience ?? 0;
    console.log(`SUCCESS - Fletching XP gained (${initialXp} -> ${finalXp}, +${result.xpGained})`);
    if (result.product) {
        console.log(`Created: ${result.product.name} x${result.product.count}`);
    }

    return finalXp > initialXp;
});
