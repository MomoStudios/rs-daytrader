#!/usr/bin/env bun
/**
 * Mining Test (SDK)
 * Mine rocks to gain Mining XP.
 *
 * Uses a pre-configured save file that spawns the bot at SE Varrock mine.
 * Success criteria: Mining XP gained (ore mined)
 */

import { runTest, dismissDialog, sleep } from './utils/test-runner';
import { TestPresets } from './utils/save-generator';

const MAX_TURNS = 100;

runTest({
    name: 'Mining Test (SDK)',
    preset: TestPresets.MINER_AT_VARROCK,
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Mine ore to gain Mining XP');

    // Wait for game state to be ready
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    const initialXp = sdk.getSkill('Mining')?.experience ?? 0;
    const initialLevel = sdk.getSkill('Mining')?.baseLevel ?? 1;
    console.log(`Initial Mining: level ${initialLevel}, XP ${initialXp}`);

    // Check for pickaxe
    const pickaxe = sdk.findInventoryItem(/pickaxe/i);
    if (!pickaxe) {
        console.log('ERROR: No pickaxe in inventory');
        return false;
    }
    console.log(`Have ${pickaxe.name}`);

    let oresMined = 0;

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const currentXp = sdk.getSkill('Mining')?.experience ?? 0;

        // Success: XP gained
        if (currentXp > initialXp) {
            console.log(`Turn ${turn}: SUCCESS - Mining XP gained (${initialXp} -> ${currentXp})`);
            console.log(`Ores mined: ${oresMined}`);
            return true;
        }

        if (turn % 20 === 0) {
            console.log(`Turn ${turn}: Mining XP=${currentXp}, ores mined=${oresMined}`);
        }

        // Handle dialogs
        if (await dismissDialog(sdk)) {
            continue;
        }

        // Find mineable rock - check for "Mine" option
        const allLocs = sdk.getNearbyLocs();
        const rock = allLocs.find(loc =>
            loc.optionsWithIndex.some(o => /mine/i.test(o.text))
        );

        if (rock) {
            const mineOption = rock.optionsWithIndex.find(o => /mine/i.test(o.text));
            if (mineOption) {
                if (turn === 1) {
                    console.log(`Found ${rock.name} at (${rock.x}, ${rock.z})`);
                    console.log(`Using option: ${mineOption.text}`);
                }

                const invBefore = sdk.getInventory().length;
                await sdk.sendInteractLoc(rock.x, rock.z, rock.id, mineOption.opIndex);

                // Wait for ore or rock to deplete
                try {
                    await sdk.waitForCondition(state => {
                        // Success: got ore
                        if (state.inventory.length > invBefore) return true;
                        // Rock depleted (no longer mineable)
                        if (!state.nearbyLocs.find(l =>
                            l.x === rock.x && l.z === rock.z && l.id === rock.id
                        )) return true;
                        // Level up dialog
                        if (state.dialog.isOpen) return true;
                        return false;
                    }, 15000);

                    if (sdk.getInventory().length > invBefore) {
                        oresMined++;
                    }
                } catch {
                    // Timeout - continue
                }
                continue;
            }
        } else {
            // Walk around to find rocks
            if (turn % 5 === 0) {
                const currentState = sdk.getState();
                const px = currentState?.player?.worldX ?? 3285;
                const pz = currentState?.player?.worldZ ?? 3365;
                const dx = Math.floor(Math.random() * 6) - 3;
                const dz = Math.floor(Math.random() * 6) - 3;
                await bot.walkTo(px + dx, pz + dz);
            }
        }

        await sleep(600);
    }

    const finalXp = sdk.getSkill('Mining')?.experience ?? 0;
    console.log(`Final Mining XP: ${finalXp} (+${finalXp - initialXp})`);
    console.log(`Ores mined: ${oresMined}`);
    return finalXp > initialXp;
});
