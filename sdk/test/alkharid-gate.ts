#!/usr/bin/env bun
import { runTest, sleep } from './utils/test-runner';

/**
 * Tests the Al Kharid toll gate mechanic.
 *
 * The toll gate works by:
 * 1. Clicking the gate triggers dialog with a nearby border guard
 * 2. Player can pay 10gp toll by selecting "Yes, ok." in dialog
 * 3. Game teleports player to the open gate position
 * 4. Player walks through to the other side
 */
runTest({
    name: 'Al Kharid Gate Test',
    saveConfig: { position: { x: 3267, z: 3228 }, coins: 20 },
}, async ({ sdk, bot }) => {
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0, 10000);

    // Find the toll gate
    const gate = sdk.getNearbyLocs().find(l => /gate/i.test(l.name));
    if (!gate) {
        console.log('ERROR: No gate found!');
        return false;
    }

    console.log(`Found gate at (${gate.x}, ${gate.z})`);

    // Click the gate to trigger guard dialog
    await sdk.sendInteractLoc(gate.x, gate.z, gate.id, 1);
    await sleep(1000);

    // Click through dialog, selecting "Yes" when available to pay toll
    for (let i = 0; i < 15; i++) {
        const state = sdk.getState();

        // Check if we teleported through
        if ((state?.player?.worldX ?? 0) >= 3270) {
            break;
        }

        // Handle dialog
        if (state?.dialog?.isOpen) {
            const yesOpt = state.dialog.options.find(o => /yes/i.test(o.text));
            if (yesOpt) {
                console.log('Paying toll...');
            }
            await sdk.sendClickDialog(yesOpt?.index ?? 0);
        }

        await sleep(300);
    }

    await sleep(500);

    // Check if we're through
    let currentX = sdk.getState()?.player?.worldX ?? 0;
    if (currentX >= 3270) {
        console.log('Teleported through gate!');
        return true;
    }

    // Walk through the now-open gate using direct walk commands
    // (bot.walkTo may fail if pathfinder doesn't know gate opened)
    console.log(`At X=${currentX}, walking through open gate...`);
    for (let targetX = currentX + 1; targetX <= 3277 && currentX < 3270; targetX++) {
        await sdk.sendWalk(targetX, 3227, false);
        await sleep(600);
        currentX = sdk.getState()?.player?.worldX ?? 0;
        if (currentX >= 3270) break;
    }

    const success = currentX >= 3270;
    console.log(success ? 'SUCCESS: Made it through!' : `FAILED: Stuck at X=${currentX}`);
    return success;
});
