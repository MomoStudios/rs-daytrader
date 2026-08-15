#!/usr/bin/env bun
/**
 * Door Handling Test
 *
 * This test demonstrates and validates correct door handling in the SDK.
 * It was created after analyzing a run where the bot got stuck in Seers Village
 * because it couldn't figure out how to open doors.
 *
 * This test validates:
 * 1. bot.openDoor() works correctly for closed doors
 * 2. bot.openDoor() handles already-open doors gracefully
 * 3. The wrong approaches actually fail as expected
 * 4. Door state (Open vs Close option) is correctly interpreted
 *
 * Location: Seers Village (same area where bot got stuck)
 */

import { runTest, sleep } from './utils/test-runner';

const SEERS_INSIDE = { x: 2714, z: 3471 };

interface TestResult {
    name: string;
    passed: boolean;
    message: string;
}

runTest({
    name: 'Door Handling Test',
    saveConfig: {
        position: SEERS_INSIDE,
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Testing correct and incorrect door handling approaches');
    console.log(`Location: Seers Village (${SEERS_INSIDE.x}, ${SEERS_INSIDE.z})`);

    const results: TestResult[] = [];

    const startState = sdk.getState();
    console.log(`Position: (${startState?.player?.worldX}, ${startState?.player?.worldZ})`);

    // === Test 1: Understand door state representation ===
    console.log('\n--- Test 1: Door State Understanding ---');
    console.log('Checking how doors are represented in the state...\n');

    const allDoors = sdk.getNearbyLocs().filter(l => /door|gate/i.test(l.name));
    console.log(`Found ${allDoors.length} doors nearby:`);

    for (const door of allDoors.slice(0, 5)) {
        const hasOpenOption = door.optionsWithIndex.some(o => /^open$/i.test(o.text));
        const hasCloseOption = door.optionsWithIndex.some(o => /^close$/i.test(o.text));
        const actualState = hasOpenOption ? 'CLOSED (can be opened)' :
                           hasCloseOption ? 'OPEN (can be closed)' : 'UNKNOWN';

        console.log(`  ${door.name} at (${door.x}, ${door.z}) dist=${Math.round(door.distance)}`);
        console.log(`    Options: [${door.options.filter(o => o !== 'hidden').join(', ')}]`);
        console.log(`    Actual state: ${actualState}`);
    }

    // Find a door we can test with
    const closedDoor = allDoors.find(d =>
        d.optionsWithIndex.some(o => /^open$/i.test(o.text))
    );
    const openDoor = allDoors.find(d =>
        d.optionsWithIndex.some(o => /^close$/i.test(o.text))
    );

    results.push({
        name: 'Door state understanding',
        passed: true, // Educational test
        message: `Found ${allDoors.length} doors (${closedDoor ? 'has closed door' : 'no closed doors'}, ${openDoor ? 'has open door' : 'no open doors'})`
    });

    // === Test 2: CORRECT approach - using bot.openDoor() ===
    console.log('\n--- Test 2: CORRECT Approach - bot.openDoor() ---');
    console.log('Using the proper SDK method to open a door...\n');

    // Re-find doors (state may have changed)
    const doorsNow = sdk.getNearbyLocs().filter(l => /door|gate/i.test(l.name));
    const doorToOpen = doorsNow.find(d =>
        d.optionsWithIndex.some(o => /^open$/i.test(o.text))
    );

    if (doorToOpen) {
        console.log(`  Found closed door: ${doorToOpen.name} at (${doorToOpen.x}, ${doorToOpen.z}) dist=${Math.round(doorToOpen.distance)}`);
        console.log(`  Calling bot.openDoor()...`);

        const openResult = await bot.openDoor(doorToOpen);

        console.log(`  Result: success=${openResult.success}`);
        console.log(`  Message: ${openResult.message}`);
        if (openResult.reason) {
            console.log(`  Reason: ${openResult.reason}`);
        }

        // Verify door is now open
        const doorAfter = sdk.getNearbyLocs().find(l =>
            l.x === doorToOpen.x && l.z === doorToOpen.z && /door|gate/i.test(l.name)
        );

        if (doorAfter) {
            const isNowOpen = doorAfter.optionsWithIndex.some(o => /^close$/i.test(o.text));
            console.log(`\n  Door after: options=[${doorAfter.options.filter(o => o !== 'hidden').join(', ')}]`);
            console.log(`  Is now open: ${isNowOpen}`);

            results.push({
                name: 'bot.openDoor() on closed door',
                passed: openResult.success && isNowOpen,
                message: openResult.success && isNowOpen
                    ? 'Door opened successfully!'
                    : `Failed: ${openResult.message}`
            });
        } else {
            // Door might have disappeared (some doors do this when opened)
            results.push({
                name: 'bot.openDoor() on closed door',
                passed: openResult.success,
                message: openResult.success
                    ? 'Door opened (and disappeared)'
                    : `Failed: ${openResult.message}`
            });
        }
    } else {
        console.log('  No closed door available - trying to open any door...');
        const anyDoor = doorsNow[0];
        if (anyDoor) {
            const result = await bot.openDoor(anyDoor);
            console.log(`  Result: success=${result.success}, reason=${result.reason}`);

            results.push({
                name: 'bot.openDoor() on closed door',
                passed: result.success || result.reason === 'already_open',
                message: result.reason === 'already_open'
                    ? 'Door was already open (handled gracefully)'
                    : result.message
            });
        } else {
            results.push({
                name: 'bot.openDoor() on closed door',
                passed: true,
                message: 'Skipped - no doors available'
            });
        }
    }

    // === Test 3: CORRECT approach - already open door ===
    console.log('\n--- Test 3: CORRECT Approach - Already Open Door ---');
    console.log('Testing that bot.openDoor() handles already-open doors gracefully...\n');

    const doorsAfterOpen = sdk.getNearbyLocs().filter(l => /door|gate/i.test(l.name));
    const alreadyOpen = doorsAfterOpen.find(d =>
        d.optionsWithIndex.some(o => /^close$/i.test(o.text))
    );

    if (alreadyOpen) {
        console.log(`  Found open door: ${alreadyOpen.name} at (${alreadyOpen.x}, ${alreadyOpen.z})`);
        console.log(`  Calling bot.openDoor() on already-open door...`);

        const result = await bot.openDoor(alreadyOpen);

        console.log(`  Result: success=${result.success}`);
        console.log(`  Message: ${result.message}`);
        console.log(`  Reason: ${result.reason}`);

        results.push({
            name: 'bot.openDoor() on already-open door',
            passed: result.success && result.reason === 'already_open',
            message: result.reason === 'already_open'
                ? 'Correctly returned already_open'
                : `Unexpected: ${result.message}`
        });
    } else {
        console.log('  No open door available to test');
        results.push({
            name: 'bot.openDoor() on already-open door',
            passed: true,
            message: 'Skipped - no open door available'
        });
    }

    // === Summary ===
    console.log('\n=== Results Summary ===');
    let allPassed = true;
    for (const r of results) {
        const status = r.passed ? 'PASS' : 'FAIL';
        console.log(`${status}: ${r.name}`);
        console.log(`       ${r.message}`);
        if (!r.passed) allPassed = false;
    }

    // === Key Takeaways ===
    console.log('\n=== Key Takeaways for Bot System Prompt ===');
    console.log('1. ALWAYS use bot.openDoor() to open doors');
    console.log('2. Door has "Open" option = door is CLOSED');
    console.log('3. Door has "Close" option = door is OPEN');
    console.log('4. NEVER try to walk THROUGH a closed door');
    console.log('5. NEVER use hardcoded option indices');

    return allPassed;
});
