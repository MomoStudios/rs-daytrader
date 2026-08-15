#!/usr/bin/env bun
/**
 * Long-Distance Navigation Test
 * Tests server-side pathfinding via the walkTo() method.
 *
 * This test validates:
 * - Server-side pathfinding API (/api/findPath)
 * - walkTo() porcelain method with built-in pathfinding
 * - Long-distance walking using calculated paths
 * - Navigation around obstacles (e.g., Lumbridge Castle's C-shape)
 */

import { launchBotWithSDK, sleep, type SDKSession } from './utils/browser';
import { generateSave, Locations } from './utils/save-generator';

const BOT_NAME = process.env.BOT_NAME ?? `nav${Math.random().toString(36).slice(2, 5)}`;

// Major locations to test navigation between
const CITIES = {
    LUMBRIDGE: { x: 3222, z: 3218, name: 'Lumbridge' },
    VARROCK: { x: 3212, z: 3428, name: 'Varrock' },
    DRAYNOR: { x: 3093, z: 3244, name: 'Draynor' },
    FALADOR: { x: 2964, z: 3378, name: 'Falador' },
    BARBARIAN_VILLAGE: { x: 3082, z: 3420, name: 'Barbarian Village' },
};

// Test routes - each defines start, destination, and expected success
const TEST_ROUTES = [
    // Easy: Short distance, minimal obstacles
    {
        name: 'Lumbridge to Draynor',
        start: Locations.LUMBRIDGE_CASTLE,
        dest: CITIES.DRAYNOR,
        maxTime: 60000, // 60s
        tolerance: 10,
    },
    // Medium: Longer distance
    {
        name: 'Lumbridge to Varrock',
        start: Locations.LUMBRIDGE_CASTLE,
        dest: CITIES.VARROCK,
        maxTime: 120000, // 120s
        tolerance: 15,
    },
    // Hard: Long distance with complex terrain
    {
        name: 'Lumbridge to Barbarian Village',
        start: Locations.LUMBRIDGE_CASTLE,
        dest: CITIES.BARBARIAN_VILLAGE,
        maxTime: 90000,
        tolerance: 15,
    },
];

interface RouteResult {
    name: string;
    success: boolean;
    distance: number;
    elapsed: number;
    message: string;
}

async function testRoute(
    route: typeof TEST_ROUTES[0],
    botName: string
): Promise<RouteResult> {
    // Generate save at start position
    await generateSave(botName, {
        position: route.start,
        skills: { Agility: 99 }, // Fast running
    });

    // Launch fresh session for this route
    const session = await launchBotWithSDK(botName, { skipTutorial: false });
    const { sdk, bot } = session;

    try {
        // Wait for state
        await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0, 10000);
        await sleep(500);

        const startState = sdk.getState();
        const startX = startState?.player?.worldX ?? 0;
        const startZ = startState?.player?.worldZ ?? 0;

        const distance = Math.sqrt(
            Math.pow(route.dest.x - startX, 2) +
            Math.pow(route.dest.z - startZ, 2)
        );

        console.log(`\n--- ${route.name} ---`);
        console.log(`  Start: (${startX}, ${startZ})`);
        console.log(`  Destination: ${route.dest.name} (${route.dest.x}, ${route.dest.z})`);
        console.log(`  Distance: ${distance.toFixed(0)} tiles`);

        const startTime = Date.now();

        // Use walkTo() which now has built-in pathfinding
        const result = await bot.walkTo(route.dest.x, route.dest.z, route.tolerance);

        const elapsed = Date.now() - startTime;

        const endState = sdk.getState();
        const endX = endState?.player?.worldX ?? 0;
        const endZ = endState?.player?.worldZ ?? 0;

        const finalDist = Math.sqrt(
            Math.pow(route.dest.x - endX, 2) +
            Math.pow(route.dest.z - endZ, 2)
        );

        console.log(`  Result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
        console.log(`  End position: (${endX}, ${endZ})`);
        console.log(`  Distance to target: ${finalDist.toFixed(0)} tiles`);
        console.log(`  Time: ${(elapsed / 1000).toFixed(1)}s`);
        console.log(`  Message: ${result.message}`);

        return {
            name: route.name,
            success: finalDist <= route.tolerance,
            distance,
            elapsed,
            message: result.message,
        };
    } finally {
        await session.cleanup();
    }
}

async function testPathfindingAPI(session: SDKSession): Promise<boolean> {
    const { sdk } = session;

    console.log('\n--- Testing /api/findPath endpoint ---');

    // Test the raw API
    const state = sdk.getState();
    if (!state?.player) {
        console.log('  FAILED: No player state');
        return false;
    }

    // Test finding path to a nearby location
    const destX = state.player.worldX + 50;
    const destZ = state.player.worldZ;

    console.log(`  Finding path from (${state.player.worldX}, ${state.player.worldZ}) to (${destX}, ${destZ})...`);

    const result = await sdk.sendFindPath(destX, destZ, 100);

    if (!result.success) {
        console.log(`  FAILED: ${result.error}`);
        return false;
    }

    console.log(`  SUCCESS: Found path with ${result.waypoints.length} waypoints`);
    console.log(`  Reached destination: ${result.reachedDestination}`);

    if (result.waypoints.length > 0) {
        const first = result.waypoints[0];
        const last = result.waypoints[result.waypoints.length - 1];
        if (first) console.log(`  First waypoint: (${first.x}, ${first.z})`);
        if (last) console.log(`  Last waypoint: (${last.x}, ${last.z})`);
    }

    return result.waypoints.length > 0;
}

async function runAllTests(): Promise<boolean> {
    console.log('=== Long-Distance Navigation Test ===');
    console.log('Testing server-side pathfinding and navigateTo()');

    // Create initial save
    await generateSave(BOT_NAME, {
        position: Locations.LUMBRIDGE_CASTLE,
        skills: { Agility: 99 },
    });

    let session: SDKSession | null = null;
    const results: RouteResult[] = [];
    let apiTestPassed = false;

    try {
        session = await launchBotWithSDK(BOT_NAME, { skipTutorial: false });

        // First, test the raw pathfinding API
        await session.sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0, 10000);
        apiTestPassed = await testPathfindingAPI(session);

        if (!apiTestPassed) {
            console.log('\nPathfinding API test failed - skipping route tests');
            return false;
        }

    } finally {
        if (session) {
            await session.cleanup();
        }
    }

    // Run all route tests (separate session per route)
    for (const route of TEST_ROUTES) {
        const result = await testRoute(route, BOT_NAME);
        results.push(result);
    }

    // Print summary
    console.log('\n=== Summary ===');
    console.log(`API Test: ${apiTestPassed ? 'PASSED' : 'FAILED'}`);

    for (const r of results) {
        const status = r.success ? 'PASSED' : 'FAILED';
        console.log(`${r.name}: ${status} (${(r.elapsed / 1000).toFixed(1)}s)`);
    }

    const allPassed = apiTestPassed && results.every(r => r.success);
    return allPassed;
}

runAllTests()
    .then(ok => {
        console.log(ok ? '\nALL TESTS PASSED' : '\nSOME TESTS FAILED');
        process.exit(ok ? 0 : 1);
    })
    .catch(e => {
        console.error('Fatal:', e);
        process.exit(1);
    });
