#!/usr/bin/env bun
/**
 * Attack Out of Reach Test (SDK)
 * Tests the attack failure mode when trying to attack from an enclosed area.
 *
 * Scenario:
 * - Position the player inside the Lumbridge chicken coop (enclosed by fence)
 * - Try to attack an NPC outside the coop (cow, goblin, etc.)
 * - Verify that attack returns success: false with reason: 'out_of_reach'
 *
 * This tests bot.attack() which detects "I can't reach that!" messages from the server
 * when pathfinding cannot find a route to the target.
 */

import { launchBotWithSDK, sleep, type SDKSession } from './utils/browser';
import { generateSave, Locations } from './utils/save-generator';

const BOT_NAME = process.env.BOT_NAME ?? `reach${Math.random().toString(36).slice(2, 5)}`;

// Position INSIDE the Lumbridge chicken coop (small fenced area)
// The coop has walls with no door, making it a true enclosed space
// Chickens inside, other NPCs outside should be unreachable
const INSIDE_CHICKEN_COOP = { x: 3233, z: 3297, level: 0 };

async function runTest(): Promise<boolean> {
    console.log('=== Attack Out of Reach Test (SDK) ===');
    console.log('Goal: Verify attack detects "can\'t reach" failure from enclosed area');

    // Create save inside chicken coop
    console.log(`Creating save file for '${BOT_NAME}' inside chicken coop...`);
    await generateSave(BOT_NAME, {
        position: INSIDE_CHICKEN_COOP,
    });

    let session: SDKSession | null = null;

    try {
        session = await launchBotWithSDK(BOT_NAME, { skipTutorial: false });
        const { sdk, bot } = session;

        // Wait for state to fully load
        await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0, 10000);
        await sleep(1000);

        console.log(`Bot '${session.botName}' ready!`);

        const startState = sdk.getState();
        console.log(`Player position: (${startState?.player?.worldX}, ${startState?.player?.worldZ})`);

        // Find NPCs outside the chicken coop
        const nearbyNpcs = sdk.getNearbyNpcs();
        console.log(`Nearby NPCs: ${nearbyNpcs.map(n => `${n.name}(dist=${n.distance})`).join(', ')}`);

        // Wait for NPCs to spawn
        await sleep(2000);

        const allNpcs = sdk.getNearbyNpcs();

        // Look for an attackable NPC (not a chicken - those are inside with us)
        // We want NPCs outside the coop like cows, goblins, etc.
        const targetNpc = allNpcs.find(n =>
            n.combatLevel > 0 &&
            !/chicken/i.test(n.name) &&
            n.distance > 1  // Should be outside the small coop
        );

        if (!targetNpc) {
            console.log('ERROR: No suitable target NPC found outside coop.');
            console.log(`Available NPCs: ${allNpcs.map(n => `${n.name}(lv${n.combatLevel}, dist=${n.distance})`).join(', ')}`);
            return false;
        }

        console.log(`Found ${targetNpc.name} (level ${targetNpc.combatLevel}) at distance ${targetNpc.distance}`);

        // Attempt to attack NPC outside the enclosed coop
        // This should fail with "can't reach" since we're fenced in
        console.log('\n--- Attempting to attack NPC from inside enclosed coop ---');
        console.log(`Using: bot.attack(${targetNpc.name})`);

        const attackResult = await bot.attack(targetNpc, 20000);  // 20s timeout

        console.log(`\nAttack result:`);
        console.log(`  success: ${attackResult.success}`);
        console.log(`  message: ${attackResult.message}`);
        console.log(`  reason: ${attackResult.reason ?? 'none'}`);

        // Check for expected failure
        if (!attackResult.success && attackResult.reason === 'out_of_reach') {
            console.log('\nSUCCESS: Attack correctly failed with "out_of_reach" reason!');
            console.log('Fence blocked the attack as expected.');
            return true;
        }

        // If attack succeeded, there might be an opening in the fence
        if (attackResult.success) {
            console.log('\nUNEXPECTED: Attack succeeded!');
            console.log('The pathfinding found a way out of the coop.');
            console.log('The chicken coop might have an opening or door.');
            return false;
        }

        // Other failure reasons
        console.log(`\nFAILED: Attack failed but with unexpected reason: ${attackResult.reason}`);
        console.log(`Expected reason: 'out_of_reach', got: '${attackResult.reason}'`);
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
