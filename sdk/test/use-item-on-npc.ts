#!/usr/bin/env bun
/**
 * useItemOnNpc Test (Sheep Shearing)
 * Tests the bot.useItemOnNpc() method by using shears on a sheep.
 *
 * Success criteria:
 * 1. Find a sheep (sheepunsheered) NPC nearby
 * 2. Use shears on the sheep via bot.useItemOnNpc()
 * 3. Wool appears in inventory
 */

import { runTest, sleep } from './utils/test-runner';

const SHEARS = 1735;

// Lumbridge sheep pen - Fred the Farmer's field
const LUMBRIDGE_SHEEP_PEN = { x: 3201, z: 3268 };

runTest({
    name: 'useItemOnNpc Test (Sheep Shearing)',
    saveConfig: {
        position: LUMBRIDGE_SHEEP_PEN,
        inventory: [
            { id: SHEARS, count: 1 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Test bot.useItemOnNpc() by shearing a sheep');
    console.log('Expected: Bot should use shears on sheep and receive wool\n');

    // Wait for state to fully load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    const pos = sdk.getState()?.player;
    console.log(`Starting position: (${pos?.worldX}, ${pos?.worldZ})`);

    // Check inventory
    const shears = sdk.findInventoryItem(/shears/i);
    if (!shears) {
        console.log('ERROR: No shears in inventory');
        return false;
    }
    console.log(`Found: ${shears.name} in slot ${shears.slot}`);

    // Find sheep
    const sheep = sdk.findNearbyNpc(/^sheep$/i);
    if (!sheep) {
        console.log('ERROR: No sheep found nearby');
        console.log('Nearby NPCs:');
        for (const npc of sdk.getNearbyNpcs().slice(0, 15)) {
            console.log(`  - ${npc.name} at (${npc.x}, ${npc.z}) dist=${npc.distance.toFixed(1)}`);
        }
        return false;
    }
    console.log(`Found sheep: index=${sheep.index} at (${sheep.x}, ${sheep.z}) dist=${sheep.distance.toFixed(1)}`);

    // Count initial wool
    const initialWool = sdk.getInventory().filter(i => /wool/i.test(i.name));
    const initialWoolCount = initialWool.reduce((sum, i) => sum + i.count, 0);
    console.log(`Initial wool count: ${initialWoolCount}`);

    // === TEST: Use shears on sheep ===
    console.log('\n--- Testing bot.useItemOnNpc() ---');
    console.log(`Using shears on sheep...`);

    // Sheep can dodge (25% chance), so retry a few times
    let success = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
        console.log(`\nAttempt ${attempt}/5...`);

        const result = await bot.useItemOnNpc(/shears/i, /^sheep$/i);
        console.log(`Result: success=${result.success}, message="${result.message}"`);
        if (result.reason) {
            console.log(`Reason: ${result.reason}`);
        }

        if (!result.success) {
            console.log('useItemOnNpc returned failure, retrying...');
            await sleep(1000);
            continue;
        }

        // Wait for wool to appear (or "manages to get away" message)
        await sleep(2000);

        // Check for wool gain
        const currentWool = sdk.getInventory().filter(i => /wool/i.test(i.name));
        const currentWoolCount = currentWool.reduce((sum, i) => sum + i.count, 0);

        if (currentWoolCount > initialWoolCount) {
            console.log(`Got wool! Count: ${initialWoolCount} -> ${currentWoolCount}`);
            success = true;
            break;
        }

        // Check game messages for "manages to get away"
        const messages = sdk.getState()?.gameMessages ?? [];
        const escaped = messages.some(m => /manages to get away/i.test(m.text));
        if (escaped) {
            console.log('Sheep escaped! Trying again...');
            await sleep(1000);
            continue;
        }

        // Might have succeeded but we missed it, or there was a delay
        console.log('No wool yet, retrying...');
        await sleep(1000);
    }

    // Final inventory check
    const finalInv = sdk.getInventory();
    console.log(`\nFinal inventory: ${finalInv.map(i => `${i.name}(${i.count})`).join(', ')}`);

    const finalWoolCount = finalInv.filter(i => /wool/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);

    console.log('\n=== Results ===');
    console.log(`Wool gained: ${finalWoolCount - initialWoolCount}`);

    if (success || finalWoolCount > initialWoolCount) {
        console.log('SUCCESS: Sheared sheep and received wool!');
        return true;
    } else {
        console.log('FAILED: Could not shear sheep after 5 attempts');
        return false;
    }
});
