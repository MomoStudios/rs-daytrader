#!/usr/bin/env bun
/**
 * Karamja Ferry Test (SDK)
 * Take the ferry from Port Sarim to Musa Point (Karamja).
 *
 * Tests the ferry travel mechanic:
 * 1. Talk to the ferryman at Port Sarim dock
 * 2. Pay the fare (30gp)
 * 3. Navigate dialog to confirm travel
 * 4. Verify arrival at Karamja (position changed)
 *
 * Success criteria: Player position changes to Karamja area (X < 3000)
 */

import { launchBotWithSDK, sleep, type SDKSession } from './utils/browser';
import { generateSave, Items } from './utils/save-generator';

const BOT_NAME = process.env.BOT_NAME ?? `ferry${Math.random().toString(36).slice(2, 5)}`;
const MAX_TURNS = 100;

// Port Sarim dock location (near the ferry)
const PORT_SARIM_DOCK = { x: 3029, z: 3217 };

// Karamja/Musa Point is around x: 2954, z: 3146
// Any X < 3000 means we've crossed to Karamja

async function runTest(): Promise<boolean> {
    console.log('=== Karamja Ferry Test (SDK) ===');
    console.log('Goal: Take ferry from Port Sarim to Karamja');

    // Generate save file at Port Sarim dock with coins for fare
    console.log(`Creating save file for '${BOT_NAME}'...`);
    await generateSave(BOT_NAME, {
        position: PORT_SARIM_DOCK,
        coins: 100,  // Ferry costs 30gp
    });

    let session: SDKSession | null = null;

    try {
        session = await launchBotWithSDK(BOT_NAME, { skipTutorial: false });
        const { sdk, bot } = session;

        // Wait for state to fully load
        await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0, 10000);
        await sleep(500);

        console.log(`Bot '${session.botName}' ready!`);

        const state = sdk.getState();
        const startX = state?.player?.worldX ?? 0;
        const startZ = state?.player?.worldZ ?? 0;
        console.log(`Start position: (${startX}, ${startZ})`);

        // Check coins
        const coins = sdk.findInventoryItem(/coins/i);
        console.log(`Coins: ${coins?.count ?? 0}`);

        if (!coins || coins.count < 30) {
            console.log('WARNING: May not have enough coins for ferry (30gp)');
        }

        for (let turn = 1; turn <= MAX_TURNS; turn++) {
            const currentState = sdk.getState();
            const currentX = currentState?.player?.worldX ?? 0;
            const currentZ = currentState?.player?.worldZ ?? 0;

            // Check for success - we've crossed to Karamja (X < 3000)
            if (currentX < 3000 && currentX > 0) {
                console.log(`Turn ${turn}: SUCCESS - Arrived at Karamja! (${currentX}, ${currentZ})`);
                return true;
            }

            // Progress logging
            if (turn % 20 === 0) {
                console.log(`Turn ${turn}: Position (${currentX}, ${currentZ})`);
            }

            // Handle dialogs - this is the main ferry interaction
            if (currentState?.dialog.isOpen) {
                const dialogText = currentState.dialog.text || '';
                const options = currentState.dialog.options;

                if (turn % 5 === 1 || options.length > 0) {
                    console.log(`Turn ${turn}: Dialog: "${dialogText.slice(0, 50)}..."`);
                    if (options.length > 0) {
                        console.log(`  Options: ${options.map(o => `${o.index}:${o.text}`).join(', ')}`);
                    }
                }

                // Look for travel/yes options
                const travelOpt = options.find(o =>
                    /yes|pay|karamja|travel|please/i.test(o.text)
                );

                if (travelOpt) {
                    console.log(`  Selecting: ${travelOpt.text}`);
                    await sdk.sendClickDialog(travelOpt.index);
                } else if (options.length > 0 && options[0]) {
                    // First option as fallback
                    await sdk.sendClickDialog(options[0].index);
                } else {
                    // Click to continue
                    await sdk.sendClickDialog(0);
                }
                await sleep(500);
                continue;
            }

            // Find the ferryman/sailor NPC
            const npcs = sdk.getNearbyNpcs();
            if (turn === 1 || turn % 30 === 0) {
                console.log(`Turn ${turn}: Nearby NPCs: ${npcs.slice(0, 10).map(n => n.name).join(', ')}`);
            }

            // Look for sailors, seaman, ferryman, captain
            const ferryman = npcs.find(npc =>
                /sailor|seaman|ferryman|captain/i.test(npc.name)
            );

            if (ferryman) {
                if (turn === 1) {
                    console.log(`Turn ${turn}: Found ${ferryman.name} with options: ${ferryman.optionsWithIndex.map(o => o.text).join(', ')}`);
                }

                if (turn % 10 === 1) {
                    console.log(`Turn ${turn}: Talking to ${ferryman.name}`);
                }

                // Use high-level bot.talkTo() instead of low-level sdk.sendInteractNpc()
                const result = await bot.talkTo(ferryman);
                if (result.success) {
                    // Dialog opened successfully
                    await sleep(500);
                }
                continue;
            }

            // Also check for gangplank or ship objects
            const locs = sdk.getNearbyLocs();
            if (turn === 1) {
                console.log(`Turn ${turn}: Nearby locs: ${locs.slice(0, 10).map(l => l.name).join(', ')}`);
            }

            const gangplank = locs.find(loc =>
                /gangplank|ship|boat|plank/i.test(loc.name) &&
                loc.optionsWithIndex.some(o => /cross|board|travel/i.test(o.text))
            );

            if (gangplank) {
                const crossOpt = gangplank.optionsWithIndex.find(o =>
                    /cross|board|travel/i.test(o.text)
                );
                if (crossOpt) {
                    console.log(`Turn ${turn}: Using ${gangplank.name} - ${crossOpt.text}`);
                    await sdk.sendInteractLoc(gangplank.x, gangplank.z, gangplank.id, crossOpt.opIndex);
                    await sleep(2000);
                    continue;
                }
            }

            // If nothing found, walk closer to dock
            if (turn % 15 === 0 && !ferryman) {
                console.log(`Turn ${turn}: Walking toward dock...`);
                await bot.walkTo(PORT_SARIM_DOCK.x, PORT_SARIM_DOCK.z);
            }

            await sleep(600);
        }

        // Final position check
        const finalState = sdk.getState();
        const finalX = finalState?.player?.worldX ?? 0;
        const finalZ = finalState?.player?.worldZ ?? 0;

        console.log(`\n=== Results ===`);
        console.log(`Start: (${startX}, ${startZ})`);
        console.log(`End: (${finalX}, ${finalZ})`);

        if (finalX < 3000 && finalX > 0) {
            console.log('SUCCESS: Made it to Karamja!');
            return true;
        } else {
            console.log('FAILED: Did not reach Karamja');
            return false;
        }

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
