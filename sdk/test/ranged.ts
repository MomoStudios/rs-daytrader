#!/usr/bin/env bun
/**
 * Ranged Combat Test (SDK)
 * Attack an NPC with ranged to gain Ranged XP.
 *
 * Uses a pre-configured save file with bow and arrows ready.
 */

import { runTest, dismissDialog, sleep } from './utils/test-runner';
import { Items } from './utils/save-generator';

const MAX_TURNS = 200;

runTest({
    name: 'Ranged Combat Test (SDK)',
    saveConfig: {
        position: { x: 3235, z: 3295 },  // Near Lumbridge chicken coop
        skills: { Ranged: 1 },
        inventory: [
            { id: Items.SHORTBOW, count: 1 },
            { id: Items.BRONZE_ARROW, count: 50 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Attack NPCs with ranged to gain Ranged XP');

    // Wait for game state to be ready (save file loaded)
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    const initialLevel = sdk.getSkill('Ranged')?.baseLevel ?? 1;
    const initialXp = sdk.getSkill('Ranged')?.experience ?? 0;
    console.log(`Initial Ranged: level ${initialLevel}, xp ${initialXp}`);

    // Equip bow and arrows using high-level action
    const bow = sdk.findInventoryItem(/bow/i);
    if (bow) {
        console.log(`Equipping ${bow.name}`);
        await bot.equipItem(bow);
        await sleep(500);
    }

    const arrows = sdk.findInventoryItem(/arrow/i);
    if (arrows) {
        console.log(`Equipping ${arrows.name}`);
        await bot.equipItem(arrows);
        await sleep(500);
    }

    let attacks = 0;

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const currentState = sdk.getState();

        // Check for success - XP gain
        const currentXp = sdk.getSkill('Ranged')?.experience ?? 0;
        if (currentXp > initialXp) {
            console.log(`Turn ${turn}: SUCCESS - Ranged XP gained (${initialXp} -> ${currentXp})`);
            return true;
        }

        // Handle dialogs
        if (await dismissDialog(sdk)) {
            continue;
        }

        // Progress logging
        if (turn % 30 === 0) {
            console.log(`Turn ${turn}: Ranged xp ${currentXp}, attacks ${attacks}`);
        }

        // Pick up arrows on the ground
        const groundArrows = sdk.findGroundItem(/arrow/i);
        if (groundArrows && groundArrows.distance <= 3) {
            if (turn % 10 === 1) {
                console.log(`Turn ${turn}: Picking up ${groundArrows.name} at (${groundArrows.x}, ${groundArrows.z})`);
            }
            await sdk.sendPickup(groundArrows.x, groundArrows.z, groundArrows.id);
            await sleep(600);
            continue;
        }

        // Find attackable NPC (prefer chickens, then rats, then anything)
        const npcs = sdk.getNearbyNpcs();
        if (turn === 1 || turn % 50 === 0) {
            console.log(`Turn ${turn}: Nearby NPCs: ${npcs.slice(0, 10).map(n => n.name).join(', ')}`);
        }

        const target = npcs.find(npc => /chicken/i.test(npc.name)) ||
                      npcs.find(npc => /rat/i.test(npc.name)) ||
                      npcs.find(npc => npc.optionsWithIndex.some(o => /attack/i.test(o.text)));

        if (target) {
            const attackOpt = target.optionsWithIndex.find(o => /attack/i.test(o.text));
            if (attackOpt) {
                if (turn % 10 === 1) {
                    console.log(`Turn ${turn}: Attacking ${target.name}`);
                }
                await sdk.sendInteractNpc(target.index, attackOpt.opIndex);
                attacks++;

                // Wait a bit for combat
                await sleep(2000);
                continue;
            }
        } else {
            // No target, walk around to find one
            if (turn % 10 === 0) {
                const px = currentState?.player?.worldX ?? 3235;
                const pz = currentState?.player?.worldZ ?? 3295;
                const dx = Math.floor(Math.random() * 10) - 5;
                const dz = Math.floor(Math.random() * 10) - 5;
                console.log(`Turn ${turn}: No targets, wandering...`);
                await bot.walkTo(px + dx, pz + dz);
            }
        }

        await sleep(600);
    }

    // Final results
    const finalXp = sdk.getSkill('Ranged')?.experience ?? 0;
    const finalLevel = sdk.getSkill('Ranged')?.baseLevel ?? 1;

    console.log(`\n=== Results ===`);
    console.log(`Ranged: level ${initialLevel} -> ${finalLevel}, xp +${finalXp - initialXp}`);
    console.log(`Attacks: ${attacks}`);

    if (finalXp > initialXp) {
        console.log('SUCCESS: Gained Ranged XP!');
        return true;
    } else {
        console.log('FAILED: No XP gained');
        return false;
    }
});
