#!/usr/bin/env bun
/**
 * Lumbridge Stairs Test (SDK)
 * Test climbing stairs up and down between 3 floors in Lumbridge Castle,
 * opening doors along the way if needed, and verifying the level is
 * correctly reflected in sdk.getState().level.
 *
 * Floors:
 * - level 0: Ground floor (cellar accessible via ladder)
 * - level 1: First floor (upstairs)
 * - level 2: Second floor (top floor with spinning wheel)
 *
 * Success criteria:
 * 1. Start on ground floor (level 0)
 * 2. Climb up to first floor, verify level === 1
 * 3. Climb up to second floor, verify level === 2
 * 4. Climb down to first floor, verify level === 1
 * 5. Climb down to ground floor, verify level === 0
 */

import { runTest, sleep } from './utils/test-runner';

const LUMBRIDGE_STAIRS = { x: 3205, z: 3208 };

interface StairsResult {
    success: boolean;
    message: string;
    levelBefore: number;
    levelAfter: number;
}

runTest({
    name: 'Lumbridge Stairs Test (SDK)',
    saveConfig: {
        position: { ...LUMBRIDGE_STAIRS, level: 0 },
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Climb up and down stairs between 3 floors, verify level changes');

    // Wait for state to fully load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0, 10000);
    await sleep(500);

    const startState = sdk.getState();
    const startLevel = startState?.player?.level ?? -1;
    console.log(`Starting position: (${startState?.player?.worldX}, ${startState?.player?.worldZ})`);
    console.log(`Starting level (floor): ${startLevel}`);

    if (startLevel !== 0) {
        console.log(`WARNING: Expected to start on level 0, but on level ${startLevel}`);
    }

    // Helper to find and open doors if they're blocking
    async function openDoorIfNeeded(): Promise<boolean> {
        const locs = sdk.getNearbyLocs();
        const door = locs.find(l =>
            /door/i.test(l.name) &&
            l.optionsWithIndex.some(o => /open/i.test(o.text))
        );
        if (door) {
            console.log(`  Opening door at (${door.x}, ${door.z})`);
            await bot.openDoor(door);
            return true;
        }
        return false;
    }

    // Helper to climb stairs
    async function useStairs(direction: 'up' | 'down'): Promise<StairsResult> {
        const levelBefore = sdk.getState()?.player?.level ?? -1;

        // Try to open any doors first
        await openDoorIfNeeded();

        // Find stairs/staircase
        const locs = sdk.getNearbyLocs();
        console.log(`  Nearby locs: ${locs.slice(0, 10).map(l => `${l.name}[${l.optionsWithIndex.map(o => o.text).join(',')}]`).join(', ')}`);

        const stairs = locs.find(l =>
            /stair|ladder/i.test(l.name) &&
            l.optionsWithIndex.some(o =>
                direction === 'up'
                    ? /climb.up|go.up/i.test(o.text)
                    : /climb.down|go.down/i.test(o.text)
            )
        );

        if (!stairs) {
            return {
                success: false,
                message: `No stairs found to go ${direction}`,
                levelBefore,
                levelAfter: levelBefore
            };
        }

        const opt = stairs.optionsWithIndex.find(o =>
            direction === 'up'
                ? /climb.up|go.up/i.test(o.text)
                : /climb.down|go.down/i.test(o.text)
        );

        if (!opt) {
            return {
                success: false,
                message: `No ${direction} option on stairs`,
                levelBefore,
                levelAfter: levelBefore
            };
        }

        console.log(`  Using ${stairs.name} at (${stairs.x}, ${stairs.z}) option: ${opt.text}`);
        await sdk.sendInteractLoc(stairs.x, stairs.z, stairs.id, opt.opIndex);

        // Wait for level to change
        const expectedLevel = direction === 'up' ? levelBefore + 1 : levelBefore - 1;
        try {
            await sdk.waitForCondition(s =>
                s.player?.level === expectedLevel,
                10000
            );
            const levelAfter = sdk.getState()?.player?.level ?? -1;
            return {
                success: true,
                message: `Climbed ${direction} from level ${levelBefore} to ${levelAfter}`,
                levelBefore,
                levelAfter
            };
        } catch {
            const levelAfter = sdk.getState()?.player?.level ?? -1;
            return {
                success: false,
                message: `Timeout waiting for level change (before: ${levelBefore}, after: ${levelAfter})`,
                levelBefore,
                levelAfter
            };
        }
    }

    const results: { step: string; result: StairsResult; expected: number }[] = [];

    // Step 1: Climb up to first floor (level 0 -> 1)
    console.log('\n--- Step 1: Climb up to first floor (level 0 -> 1) ---');
    const step1 = await useStairs('up');
    console.log(`  Result: ${step1.success ? 'SUCCESS' : 'FAILED'} - ${step1.message}`);
    console.log(`  Level: ${step1.levelAfter} (expected: 1)`);
    results.push({ step: 'Ground to 1st floor', result: step1, expected: 1 });

    await sleep(500);

    // Step 2: Climb up to second floor (level 1 -> 2)
    console.log('\n--- Step 2: Climb up to second floor (level 1 -> 2) ---');
    const step2 = await useStairs('up');
    console.log(`  Result: ${step2.success ? 'SUCCESS' : 'FAILED'} - ${step2.message}`);
    console.log(`  Level: ${step2.levelAfter} (expected: 2)`);
    results.push({ step: '1st to 2nd floor', result: step2, expected: 2 });

    await sleep(500);

    // Step 3: Climb down to first floor (level 2 -> 1)
    console.log('\n--- Step 3: Climb down to first floor (level 2 -> 1) ---');
    const step3 = await useStairs('down');
    console.log(`  Result: ${step3.success ? 'SUCCESS' : 'FAILED'} - ${step3.message}`);
    console.log(`  Level: ${step3.levelAfter} (expected: 1)`);
    results.push({ step: '2nd to 1st floor', result: step3, expected: 1 });

    await sleep(500);

    // Step 4: Climb down to ground floor (level 1 -> 0)
    console.log('\n--- Step 4: Climb down to ground floor (level 1 -> 0) ---');
    const step4 = await useStairs('down');
    console.log(`  Result: ${step4.success ? 'SUCCESS' : 'FAILED'} - ${step4.message}`);
    console.log(`  Level: ${step4.levelAfter} (expected: 0)`);
    results.push({ step: '1st to ground floor', result: step4, expected: 0 });

    // Summary
    console.log('\n=== Results Summary ===');
    let allPassed = true;
    for (const { step, result, expected } of results) {
        const levelCorrect = result.levelAfter === expected;
        const passed = result.success && levelCorrect;
        console.log(`${passed ? 'PASS' : 'FAIL'}: ${step}`);
        console.log(`  - Action: ${result.success ? 'OK' : 'FAILED'}`);
        console.log(`  - Level: ${result.levelAfter} (expected: ${expected}) ${levelCorrect ? 'OK' : 'WRONG'}`);
        if (!passed) allPassed = false;
    }

    const finalLevel = sdk.getState()?.player?.level ?? -1;
    console.log(`\nFinal level: ${finalLevel} (should be 0)`);

    if (allPassed && finalLevel === 0) {
        console.log('\nSUCCESS: All stairs climbed correctly and levels verified!');
        return true;
    } else {
        console.log('\nFAILED: Some steps did not complete correctly');
        return false;
    }
});
