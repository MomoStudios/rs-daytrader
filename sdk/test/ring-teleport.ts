#!/usr/bin/env bun
/**
 * Enchanted Ring Teleport Test (SDK)
 * Test using an enchanted ring (Ring of Dueling) to teleport.
 *
 * Ring of Dueling teleports to:
 * - Duel Arena (Al Kharid)
 * - Castle Wars
 *
 * Success criteria:
 * 1. Start with Ring of Dueling in inventory
 * 2. Use "Rub" option on ring
 * 3. Select teleport destination from dialog
 * 4. Verify position changed (teleported successfully)
 */

import { launchBotWithSDK, sleep, type SDKSession } from './utils/browser';
import { generateSave, Locations } from './utils/save-generator';

const BOT_NAME = process.env.BOT_NAME ?? `ring${Math.random().toString(36).slice(2, 5)}`;
const MAX_TURNS = 100;

// Ring of Dueling item IDs (charges 8 down to 1)
const RING_OF_DUELING_8 = 2552;
const RING_OF_DUELING_7 = 2554;
const RING_OF_DUELING_6 = 2556;
const RING_OF_DUELING_5 = 2558;
const RING_OF_DUELING_4 = 2560;
const RING_OF_DUELING_3 = 2562;
const RING_OF_DUELING_2 = 2564;
const RING_OF_DUELING_1 = 2566;

// Duel Arena location (approximate)
const DUEL_ARENA = { x: 3316, z: 3234 };

// Castle Wars location (approximate)
const CASTLE_WARS = { x: 2440, z: 3090 };

async function runTest(): Promise<boolean> {
    console.log('=== Enchanted Ring Teleport Test (SDK) ===');
    console.log('Goal: Use Ring of Dueling to teleport');

    // Generate save file with Ring of Dueling at Lumbridge
    console.log(`Creating save file for '${BOT_NAME}'...`);
    await generateSave(BOT_NAME, {
        position: Locations.LUMBRIDGE_CASTLE,  // Start at Lumbridge
        inventory: [
            { id: RING_OF_DUELING_8, count: 1 },  // Ring of Dueling (8 charges)
        ],
    });

    let session: SDKSession | null = null;

    try {
        session = await launchBotWithSDK(BOT_NAME, { skipTutorial: false });
        const { sdk } = session;

        // Wait for state to fully load
        await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
        await sleep(500);

        console.log(`Bot '${session.botName}' ready!`);

        // Record starting position
        const state = sdk.getState();
        const startX = state?.player?.worldX ?? 0;
        const startZ = state?.player?.worldZ ?? 0;
        console.log(`Starting position: (${startX}, ${startZ})`);

        // Find the Ring of Dueling
        const ring = sdk.getInventory().find(i =>
            /ring of dueling/i.test(i.name) || /dueling/i.test(i.name)
        );

        if (!ring) {
            console.log('ERROR: Ring of Dueling not found in inventory');
            console.log(`Inventory: ${sdk.getInventory().map(i => i.name).join(', ')}`);
            return false;
        }

        console.log(`Found ring: ${ring.name} (slot ${ring.slot})`);
        console.log(`Options: ${ring.optionsWithIndex.map(o => `${o.opIndex}:${o.text}`).join(', ')}`);

        // Find the "Rub" option (teleport option for jewelry)
        const rubOpt = ring.optionsWithIndex.find(o =>
            /rub|operate|teleport/i.test(o.text)
        );

        if (!rubOpt) {
            console.log('ERROR: No rub/teleport option on ring');
            console.log('Available options:', ring.optionsWithIndex.map(o => o.text));
            return false;
        }

        console.log(`\n--- Rubbing ring (option ${rubOpt.opIndex}: ${rubOpt.text}) ---`);
        await sdk.sendUseItem(ring.slot, rubOpt.opIndex);
        await sleep(1000);

        // Handle the teleport destination dialog
        let dialogHandled = false;
        for (let turn = 1; turn <= MAX_TURNS; turn++) {
            const currentState = sdk.getState();
            const currentX = currentState?.player?.worldX ?? 0;
            const currentZ = currentState?.player?.worldZ ?? 0;

            // Check if we've teleported
            const distFromStart = Math.abs(currentX - startX) + Math.abs(currentZ - startZ);
            const distFromDuelArena = Math.abs(currentX - DUEL_ARENA.x) + Math.abs(currentZ - DUEL_ARENA.z);
            const distFromCastleWars = Math.abs(currentX - CASTLE_WARS.x) + Math.abs(currentZ - CASTLE_WARS.z);

            if (distFromStart > 50) {
                console.log(`Turn ${turn}: TELEPORTED! New position: (${currentX}, ${currentZ})`);

                if (distFromDuelArena < 100) {
                    console.log('Destination: Duel Arena');
                } else if (distFromCastleWars < 100) {
                    console.log('Destination: Castle Wars');
                } else {
                    console.log('Destination: Unknown location');
                }

                console.log(`\n=== SUCCESS ===`);
                console.log(`- Started at: (${startX}, ${startZ})`);
                console.log(`- Teleported to: (${currentX}, ${currentZ})`);
                console.log(`- Distance traveled: ${distFromStart}`);
                return true;
            }

            // Handle dialog for choosing destination
            if (currentState?.dialog.isOpen && !dialogHandled) {
                console.log(`Turn ${turn}: Dialog opened - selecting teleport destination`);

                // Usually first option is a valid teleport destination
                // Dialog options might be: 1=Duel Arena, 2=Castle Wars, etc.
                await sdk.sendClickDialog(1);  // Select first teleport option (Duel Arena)
                dialogHandled = true;
                await sleep(3000);  // Wait for teleport animation
                continue;
            }

            // If no dialog, try rubbing the ring again
            if (!dialogHandled && turn % 10 === 0) {
                const currentRing = sdk.getInventory().find(i =>
                    /ring of dueling|dueling/i.test(i.name)
                );
                if (currentRing) {
                    const currentRubOpt = currentRing.optionsWithIndex.find(o =>
                        /rub|operate|teleport/i.test(o.text)
                    );
                    if (currentRubOpt) {
                        console.log(`Turn ${turn}: Retrying ring rub...`);
                        await sdk.sendUseItem(currentRing.slot, currentRubOpt.opIndex);
                        await sleep(1000);
                    }
                }
            }

            // Progress logging
            if (turn % 20 === 0) {
                console.log(`Turn ${turn}: Position (${currentX}, ${currentZ}), waiting for teleport...`);
            }

            await sleep(600);
        }

        // Final check
        const finalState = sdk.getState();
        const finalX = finalState?.player?.worldX ?? 0;
        const finalZ = finalState?.player?.worldZ ?? 0;
        const finalDist = Math.abs(finalX - startX) + Math.abs(finalZ - startZ);

        console.log(`\n=== Results ===`);
        console.log(`Start position: (${startX}, ${startZ})`);
        console.log(`Final position: (${finalX}, ${finalZ})`);
        console.log(`Distance moved: ${finalDist}`);

        if (finalDist > 50) {
            console.log('SUCCESS: Teleported via ring!');
            return true;
        } else {
            console.log('FAILED: Did not teleport');
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
