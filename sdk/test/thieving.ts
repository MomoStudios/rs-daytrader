#!/usr/bin/env bun
/**
 * Thieving Test (SDK)
 * Steal from tea stall or pickpocket NPCs to gain Thieving XP.
 *
 * Uses the Varrock tea stall location for level 5 thieving.
 */

import { runTest, dismissDialog, sleep } from './utils/test-runner';
import { Locations } from './utils/save-generator';

const MAX_TURNS = 150;

runTest({
    name: 'Thieving Test (SDK)',
    saveConfig: {
        position: Locations.VARROCK_TEA_STALL,
        skills: { Thieving: 5 },  // Tea stall requires level 5
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Steal from stall or pickpocket to gain Thieving XP');

    // Wait for state to fully load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0, 10000);
    await sleep(500);

    const initialLevel = sdk.getSkill('Thieving')?.baseLevel ?? 1;
    const initialXp = sdk.getSkill('Thieving')?.experience ?? 0;
    console.log(`Initial Thieving: level ${initialLevel}, xp ${initialXp}`);

    let steals = 0;

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const currentState = sdk.getState();

        // Check for success - XP gain
        const currentXp = sdk.getSkill('Thieving')?.experience ?? 0;
        if (currentXp > initialXp) {
            console.log(`Turn ${turn}: SUCCESS - Thieving XP gained (${initialXp} -> ${currentXp})`);
            return true;
        }

        // Handle dialogs (stunned message, etc.)
        if (await dismissDialog(sdk)) {
            continue;
        }

        // Progress logging
        if (turn % 30 === 0) {
            console.log(`Turn ${turn}: Thieving xp ${currentXp}, steals attempted ${steals}`);
        }

        // Look for stalls to steal from
        const allLocs = sdk.getNearbyLocs();
        if (turn === 1 || turn % 50 === 0) {
            console.log(`Turn ${turn}: Nearby locs: ${allLocs.slice(0, 10).map(l => l.name).join(', ')}`);
        }

        // Find tea stall or any stall with "Steal" option
        const teaStall = allLocs.find(loc => /tea stall/i.test(loc.name));
        if (turn === 1 && teaStall) {
            console.log(`Tea stall options: ${teaStall.optionsWithIndex.map(o => `${o.opIndex}:${o.text}`).join(', ') || 'none'}`);
        }

        const stall = allLocs.find(loc =>
            /stall|stand/i.test(loc.name) &&
            loc.optionsWithIndex.some(o => /steal/i.test(o.text))
        );

        if (stall) {
            const stealOpt = stall.optionsWithIndex.find(o => /steal/i.test(o.text));
            if (stealOpt) {
                if (turn === 1 || turn % 30 === 1) {
                    console.log(`Turn ${turn}: Stealing from ${stall.name} at (${stall.x}, ${stall.z}) option ${stealOpt.opIndex}: ${stealOpt.text}`);
                }
                await sdk.sendInteractLoc(stall.x, stall.z, stall.id, stealOpt.opIndex);
                steals++;

                // Wait for XP gain or failure
                try {
                    await sdk.waitForCondition(state => {
                        const xp = state.skills.find(s => s.name === 'Thieving')?.experience ?? 0;
                        if (xp > initialXp) return true;
                        // Dialog (caught/stunned)
                        if (state.dialog.isOpen) return true;
                        return false;
                    }, 5000);
                } catch { /* timeout */ }
                continue;
            }
        }

        // If no stall found, try pickpocketing
        const npcs = sdk.getNearbyNpcs();
        const target = npcs.find(npc =>
            /^man$|^woman$/i.test(npc.name) &&
            npc.optionsWithIndex.some(o => /pickpocket/i.test(o.text))
        );

        if (target) {
            const pickOpt = target.optionsWithIndex.find(o => /pickpocket/i.test(o.text));
            if (pickOpt) {
                if (turn % 10 === 1) {
                    console.log(`Turn ${turn}: Pickpocketing ${target.name}`);
                }
                await sdk.sendInteractNpc(target.index, pickOpt.opIndex);
                steals++;

                // Wait for XP gain or failure
                try {
                    await sdk.waitForCondition(state => {
                        const xp = state.skills.find(s => s.name === 'Thieving')?.experience ?? 0;
                        if (xp > initialXp) return true;
                        if (state.dialog.isOpen) return true;
                        return false;
                    }, 5000);
                } catch { /* timeout */ }
                continue;
            }
        }

        // If nothing found, wander around
        if (turn % 15 === 0 && !stall && !target) {
            const px = currentState?.player?.worldX ?? Locations.VARROCK_TEA_STALL.x;
            const pz = currentState?.player?.worldZ ?? Locations.VARROCK_TEA_STALL.z;
            const dx = Math.floor(Math.random() * 10) - 5;
            const dz = Math.floor(Math.random() * 10) - 5;
            console.log(`Turn ${turn}: No stalls or targets, wandering...`);
            await bot.walkTo(px + dx, pz + dz);
        }

        await sleep(600);
    }

    // Final results
    const finalXp = sdk.getSkill('Thieving')?.experience ?? 0;
    const finalLevel = sdk.getSkill('Thieving')?.baseLevel ?? 1;

    console.log(`\n=== Results ===`);
    console.log(`Thieving: level ${initialLevel} -> ${finalLevel}, xp +${finalXp - initialXp}`);
    console.log(`Steal attempts: ${steals}`);

    if (finalXp > initialXp) {
        console.log('SUCCESS: Gained Thieving XP!');
        return true;
    } else {
        console.log('FAILED: No XP gained');
        return false;
    }
});
