#!/usr/bin/env bun
/**
 * Agility Test (SDK)
 * Complete agility obstacles to gain Agility XP.
 *
 * Uses the Gnome Stronghold agility course - the simplest course for level 1.
 * Tests the ability to interact with agility obstacles.
 *
 * Success criteria: Gain Agility XP (complete at least one obstacle)
 */

import { runTest, dismissDialog, sleep } from './utils/test-runner';

const MAX_TURNS = 150;
const GNOME_AGILITY_START = { x: 2474, z: 3436 };

runTest({
    name: 'Agility Test (SDK)',
    saveConfig: {
        position: GNOME_AGILITY_START,
        skills: { Agility: 1 },
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Complete agility obstacles to gain Agility XP');

    const initialLevel = sdk.getSkill('Agility')?.baseLevel ?? 1;
    const initialXp = sdk.getSkill('Agility')?.experience ?? 0;
    console.log(`Initial Agility: level ${initialLevel}, xp ${initialXp}`);

    let obstaclesCompleted = 0;

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const currentState = sdk.getState();

        // Check for success - XP gain
        const currentXp = sdk.getSkill('Agility')?.experience ?? 0;
        if (currentXp > initialXp) {
            console.log(`Turn ${turn}: SUCCESS - Agility XP gained! (${initialXp} -> ${currentXp})`);
            return true;
        }

        // Progress logging
        if (turn % 30 === 0) {
            console.log(`Turn ${turn}: Agility xp ${currentXp}, obstacles ${obstaclesCompleted}`);
            console.log(`  Position: (${currentState?.player?.worldX}, ${currentState?.player?.worldZ})`);
        }

        // Handle dialogs
        if (await dismissDialog(sdk)) {
            continue;
        }

        // Find agility obstacles
        const locs = sdk.getNearbyLocs();
        if (turn === 1 || turn % 40 === 0) {
            const uniqueNames = [...new Set(locs.map(l => l.name))].slice(0, 15);
            console.log(`Turn ${turn}: Nearby locs: ${uniqueNames.join(', ')}`);
        }

        // Look for agility obstacles with walk/climb/cross/jump options
        const agilityObstacle = locs.find(loc =>
            loc.optionsWithIndex.some(o =>
                /walk|climb|cross|jump|balance|squeeze|swing/i.test(o.text)
            )
        );

        if (agilityObstacle) {
            const agilityOpt = agilityObstacle.optionsWithIndex.find(o =>
                /walk|climb|cross|jump|balance|squeeze|swing/i.test(o.text)
            );

            if (agilityOpt) {
                if (turn === 1 || turn % 20 === 1) {
                    console.log(`Turn ${turn}: Found ${agilityObstacle.name} with option: ${agilityOpt.text}`);
                    console.log(`  At (${agilityObstacle.x}, ${agilityObstacle.z})`);
                }

                await sdk.sendInteractLoc(agilityObstacle.x, agilityObstacle.z, agilityObstacle.id, agilityOpt.opIndex);
                obstaclesCompleted++;

                // Wait for XP gain or position change (obstacle completion)
                const startX = currentState?.player?.worldX ?? 0;
                const startZ = currentState?.player?.worldZ ?? 0;

                try {
                    await sdk.waitForCondition(state => {
                        // XP gain
                        const xp = state.skills.find(s => s.name === 'Agility')?.experience ?? 0;
                        if (xp > initialXp) return true;

                        // Position changed significantly (moved across obstacle)
                        const dx = Math.abs((state.player?.worldX ?? 0) - startX);
                        const dz = Math.abs((state.player?.worldZ ?? 0) - startZ);
                        if (dx > 3 || dz > 3) return true;

                        // Dialog opened
                        if (state.dialog.isOpen) return true;

                        return false;
                    }, 15000);
                } catch {
                    console.log(`Turn ${turn}: Obstacle interaction timed out`);
                }
                continue;
            }
        }

        // If no obstacle found, look for common agility course objects by name
        const namedObstacle = locs.find(loc =>
            /log|net|rope|branch|pipe|wall|ledge|hurdle|plank/i.test(loc.name)
        );

        const obstacleOpt = namedObstacle?.optionsWithIndex[0];
        if (namedObstacle && obstacleOpt) {
            if (turn % 15 === 1) {
                console.log(`Turn ${turn}: Trying ${namedObstacle.name} - ${obstacleOpt.text}`);
            }
            await sdk.sendInteractLoc(namedObstacle.x, namedObstacle.z, namedObstacle.id, obstacleOpt.opIndex);
            await sleep(3000);
            continue;
        }

        // Walk around to find obstacles
        if (turn % 20 === 0) {
            const px = currentState?.player?.worldX ?? GNOME_AGILITY_START.x;
            const pz = currentState?.player?.worldZ ?? GNOME_AGILITY_START.z;
            const dx = Math.floor(Math.random() * 16) - 8;
            const dz = Math.floor(Math.random() * 16) - 8;
            console.log(`Turn ${turn}: No obstacles found, exploring...`);
            await bot.walkTo(px + dx, pz + dz);
        }

        await sleep(600);
    }

    // Final results
    const finalXp = sdk.getSkill('Agility')?.experience ?? 0;
    const finalLevel = sdk.getSkill('Agility')?.baseLevel ?? 1;

    console.log(`\n=== Results ===`);
    console.log(`Agility: level ${initialLevel} -> ${finalLevel}, xp +${finalXp - initialXp}`);
    console.log(`Obstacles attempted: ${obstaclesCompleted}`);

    if (finalXp > initialXp) {
        console.log('SUCCESS: Gained Agility XP!');
        return true;
    } else {
        console.log('FAILED: No XP gained');
        return false;
    }
});
