#!/usr/bin/env bun
/**
 * Woodcutting & Firemaking Test using SDK
 * Goal: Gain 1 level in Woodcutting and 1 level in Firemaking, then exit.
 *
 * Demonstrates:
 * - SDK plumbing (sendInteractLoc, waitForCondition)
 * - SDK porcelain (chopTree, burnLogs, pickupItem)
 * - Type-safe state access (no regex parsing!)
 */

import { BotSDK } from '..';
import { BotActions } from '../actions';
import { launchBotBrowser, skipTutorial, sleep, type BrowserSession } from './utils/browser';

const BOT_NAME = process.env.BOT_NAME;

async function runTest(): Promise<boolean> {
    console.log('=== Woodcutting & Firemaking Test (SDK) ===');

    let browser: BrowserSession | null = null;
    let sdk: BotSDK | null = null;

    try {
        // Launch browser with game client
        console.log('Launching browser...');
        browser = await launchBotBrowser(BOT_NAME);
        console.log(`Bot '${browser.botName}' ready`);

        // Connect SDK to sync server
        console.log('Connecting SDK...');
        sdk = new BotSDK({ botUsername: browser.botName });
        await sdk.connect();
        console.log('SDK connected');

        // Wait for game to be ready (inGame state)
        console.log('Waiting for game state...');
        await sdk.waitForCondition(s => s.inGame, 30000);
        console.log('In game');

        // Skip tutorial
        console.log('Skipping tutorial...');
        const tutorialSkipped = await skipTutorial(sdk);
        if (!tutorialSkipped) {
            console.error('Failed to skip tutorial');
            return false;
        }
        console.log('Tutorial skipped');

        // Wait for state to settle after tutorial
        await sleep(1000);

        // Create porcelain wrapper for high-level actions
        const bot = new BotActions(sdk);

        // Get initial levels
        const initWc = sdk.getSkill('Woodcutting')?.baseLevel ?? 1;
        const initFm = sdk.getSkill('Firemaking')?.baseLevel ?? 1;
        console.log(`Initial levels: WC=${initWc}, FM=${initFm}`);

        // Main loop
        for (let turn = 1; turn <= 200; turn++) {
            const wc = sdk.getSkill('Woodcutting')?.baseLevel ?? 1;
            const fm = sdk.getSkill('Firemaking')?.baseLevel ?? 1;

            // Success condition: gained 1 level in both WC and FM
            if (wc > initWc && fm > initFm) {
                console.log(`Turn ${turn}: SUCCESS - WC ${initWc}->${wc}, FM ${initFm}->${fm}`);
                return true;
            }

            // Get tinderbox if needed
            if (!sdk.findInventoryItem(/tinderbox/i)) {
                const groundTinder = sdk.findGroundItem(/tinderbox/i);
                if (groundTinder) {
                    console.log(`Turn ${turn}: Picking up tinderbox`);
                    const result = await bot.pickupItem(groundTinder);
                    if (!result.success) {
                        console.log(`  Failed: ${result.message}`);
                    }
                    continue;
                }
            }

            const logs = sdk.findInventoryItem(/logs/i);
            const tinderbox = sdk.findInventoryItem(/tinderbox/i);

            // Burn logs if we have them and need FM level
            if (logs && tinderbox && fm === initFm) {
                console.log(`Turn ${turn}: Burning logs`);
                const result = await bot.burnLogs(logs);
                if (!result.success) {
                    console.log(`  Failed: ${result.message}`);
                }
                continue;
            }

            // Chop tree if we need WC level or logs
            if (wc === initWc || !logs) {
                const tree = sdk.findNearbyLoc(/^tree$/i);
                if (tree) {
                    if (turn % 5 === 0 || !logs) {
                        console.log(`Turn ${turn}: Chopping tree at (${tree.x}, ${tree.z})`);
                    }
                    const result = await bot.chopTree(tree);
                    if (!result.success) {
                        console.log(`  Failed: ${result.message}`);
                    }
                } else {
                    // No tree found - wander to find one
                    const player = sdk.getState()?.player;
                    if (player) {
                        const dx = Math.floor(Math.random() * 10) - 5;
                        const dz = Math.floor(Math.random() * 10) - 5;
                        const targetX = player.worldX + dx;
                        const targetZ = player.worldZ + dz;
                        console.log(`Turn ${turn}: No tree nearby, wandering to (${targetX}, ${targetZ})`);
                        await bot.walkTo(targetX, targetZ);
                    }
                }
                continue;
            }

            // Have logs and tinderbox, burn them
            if (logs && tinderbox) {
                console.log(`Turn ${turn}: Burning more logs`);
                await bot.burnLogs(logs);
            }

            // Progress logging
            if (turn % 20 === 0) {
                console.log(`Turn ${turn}: WC ${initWc}->${wc}, FM ${initFm}->${fm}`);
            }
        }

        console.log('Reached max turns without completing');
        return false;

    } catch (error) {
        console.error('Fatal error:', error);
        return false;

    } finally {
        if (sdk) {
            console.log('Disconnecting SDK...');
            await sdk.disconnect();
        }
        if (browser) {
            await browser.cleanup();
        }
    }
}

// Run the test
runTest()
    .then(ok => {
        console.log(ok ? '\nPASSED' : '\nFAILED');
        process.exit(ok ? 0 : 1);
    })
    .catch(e => {
        console.error('Fatal:', e);
        process.exit(1);
    });
