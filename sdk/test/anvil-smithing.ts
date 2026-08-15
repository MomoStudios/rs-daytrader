#!/usr/bin/env bun
/**
 * Anvil Smithing Test (SDK)
 * Smith bronze bars into bronze daggers at Varrock anvil.
 *
 * Uses a pre-configured save file that spawns near the anvil with bars ready.
 * This is an atomic test - smelting is tested separately in smithing.ts.
 */

import { runTest } from './utils/test-runner';
import { Items } from './utils/save-generator';

const ANVIL_AREA = { x: 3190, z: 3424 };

runTest({
    name: 'Anvil Smithing Test (SDK)',
    saveConfig: {
        position: ANVIL_AREA,
        skills: { Smithing: 1 },
        inventory: [
            { id: Items.BRONZE_BAR, count: 1 },
            { id: Items.HAMMER, count: 1 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Smith bronze bars into bronze daggers');

    // Wait for state to fully load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);

    const initialLevel = sdk.getSkill('Smithing')?.baseLevel ?? 1;
    const initialXp = sdk.getSkill('Smithing')?.experience ?? 0;
    console.log(`Initial Smithing: level ${initialLevel}, xp ${initialXp}`);

    // Check inventory
    const barCount = sdk.getInventory().filter(i => /bronze bar/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);
    const hasHammer = sdk.getInventory().some(i => /hammer/i.test(i.name));
    console.log(`Inventory: ${barCount} bronze bars, hammer: ${hasHammer}`);

    if (barCount < 1 || !hasHammer) {
        console.log('ERROR: Missing bars or hammer in inventory');
        return false;
    }

    // Use the high-level smithAtAnvil action
    console.log('Smithing bronze dagger...');
    const result = await bot.smithAtAnvil('dagger', { barPattern: /bronze bar/i });

    // Report results
    const finalLevel = sdk.getSkill('Smithing')?.baseLevel ?? 1;
    const finalXp = sdk.getSkill('Smithing')?.experience ?? 0;

    console.log(`\n=== Results ===`);
    console.log(`Result: ${result.success ? 'SUCCESS' : 'FAILED'} - ${result.message}`);
    if (result.xpGained) console.log(`XP gained: ${result.xpGained}`);
    if (result.product) console.log(`Product: ${result.product.name}`);
    console.log(`Smithing: level ${initialLevel} -> ${finalLevel}, xp +${finalXp - initialXp}`);

    return result.success;
});
