#!/usr/bin/env bun
/**
 * useItemOnLoc Test (Catherby)
 * Tests the new bot.useItemOnLoc() porcelain method which handles:
 * - Walking to the location
 * - Opening doors automatically
 * - Using item on location
 *
 * Spawns outside the Catherby range building to test door handling.
 */

import { runTest, sleep } from './utils/test-runner';
import { Items } from './utils/save-generator';

// Catherby range is inside a building - spawn outside to test door handling
const CATHERBY_OUTSIDE_RANGE = { x: 2816, z: 3439 };  // Outside the building
const CATHERBY_RANGE_APPROX = { x: 2817, z: 3443 };   // Range is inside

runTest({
    name: 'useItemOnLoc Test (Catherby)',
    saveConfig: {
        position: CATHERBY_OUTSIDE_RANGE,
        skills: { Cooking: 40 },  // High enough to not burn
        inventory: [
            { id: Items.RAW_SHRIMPS, count: 5 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Test bot.useItemOnLoc() with door handling in Catherby');
    console.log('Expected: Bot should walk to range, open door if needed, and cook fish\n');

    // Wait for state to fully load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    const initialXp = sdk.getSkill('Cooking')?.experience ?? 0;
    const pos = sdk.getState()?.player;
    console.log(`Starting position: (${pos?.worldX}, ${pos?.worldZ})`);
    console.log(`Initial Cooking XP: ${initialXp}`);

    // Check inventory
    const rawFish = sdk.findInventoryItem(/raw/i);
    if (!rawFish) {
        console.log('ERROR: No raw fish in inventory');
        return false;
    }
    console.log(`Found: ${rawFish.name} x${rawFish.count}`);

    // Find range
    const range = sdk.findNearbyLoc(/range|stove/i);
    if (!range) {
        console.log('ERROR: No range found nearby');
        console.log('Nearby locs:');
        for (const loc of sdk.getNearbyLocs().slice(0, 15)) {
            console.log(`  - ${loc.name} at (${loc.x}, ${loc.z}) dist=${loc.distance.toFixed(1)}`);
        }
        return false;
    }
    console.log(`Found range: ${range.name} at (${range.x}, ${range.z}) dist=${range.distance.toFixed(1)}`);

    // Check for doors between us and the range
    const doors = sdk.getNearbyLocs().filter(l => /door|gate/i.test(l.name));
    if (doors.length > 0) {
        console.log(`Doors nearby: ${doors.map(d => `${d.name} at (${d.x},${d.z})`).join(', ')}`);
    }

    // === TEST: Use the new useItemOnLoc method ===
    console.log('\n--- Testing bot.useItemOnLoc() ---');
    console.log(`Using ${rawFish.name} on ${range.name}...`);

    const result = await bot.useItemOnLoc(/raw/i, /range|stove/i);

    console.log(`Result: success=${result.success}, message="${result.message}"`);
    if (result.reason) {
        console.log(`Reason: ${result.reason}`);
    }

    if (!result.success) {
        console.log('FAILED: useItemOnLoc returned failure');
        return false;
    }

    // After useItemOnLoc succeeds, we should have a cooking dialog/interface open
    // or the player should be animating
    const state = sdk.getState();
    const posAfter = state?.player;
    console.log(`Position after: (${posAfter?.worldX}, ${posAfter?.worldZ})`);

    if (state?.dialog.isOpen) {
        console.log('Cooking dialog opened - clicking to cook...');
        // Click through cooking dialog
        const cookOpt = state.dialog.options.find(o => /cook/i.test(o.text));
        if (cookOpt) {
            await sdk.sendClickDialog(cookOpt.index);
        } else if (state.dialog.options.length > 0) {
            await sdk.sendClickDialog(state.dialog.options[0]!.index);
        } else {
            await sdk.sendClickDialog(0);
        }
    } else if (state?.interface?.isOpen) {
        console.log('Cooking interface opened - clicking to cook...');
        await sdk.sendClickInterfaceOption(0);
    } else if (state?.player?.animId !== -1) {
        console.log(`Player is animating (animId=${state!.player!.animId}) - cooking in progress`);
    }

    // Wait for cooking XP
    console.log('Waiting for cooking XP...');
    try {
        await sdk.waitForCondition(s => {
            const xp = s.skills.find(sk => sk.name === 'Cooking')?.experience ?? 0;
            return xp > initialXp;
        }, 15000);

        const finalXp = sdk.getSkill('Cooking')?.experience ?? 0;
        console.log(`\n=== SUCCESS ===`);
        console.log(`Cooking XP: ${initialXp} -> ${finalXp} (+${finalXp - initialXp})`);
        return true;
    } catch {
        // Maybe need to handle another dialog click
        const currentState = sdk.getState();
        if (currentState?.dialog.isOpen || currentState?.interface?.isOpen) {
            console.log('Still have dialog/interface open, trying another click...');
            if (currentState.dialog.isOpen) {
                await sdk.sendClickDialog(0);
            } else {
                await sdk.sendClickInterfaceOption(0);
            }

            // Wait again
            try {
                await sdk.waitForCondition(s => {
                    const xp = s.skills.find(sk => sk.name === 'Cooking')?.experience ?? 0;
                    return xp > initialXp;
                }, 10000);

                const finalXp = sdk.getSkill('Cooking')?.experience ?? 0;
                console.log(`\n=== SUCCESS ===`);
                console.log(`Cooking XP: ${initialXp} -> ${finalXp} (+${finalXp - initialXp})`);
                return true;
            } catch {
                console.log('FAILED: Timeout waiting for cooking XP (second attempt)');
            }
        }

        const finalXp = sdk.getSkill('Cooking')?.experience ?? 0;
        if (finalXp > initialXp) {
            console.log(`\n=== SUCCESS ===`);
            console.log(`Cooking XP: ${initialXp} -> ${finalXp} (+${finalXp - initialXp})`);
            return true;
        }

        console.log('FAILED: Timeout waiting for cooking XP');
        return false;
    }
});
