#!/usr/bin/env bun
/**
 * Teleport Test (SDK)
 * Cast Varrock Teleport spell.
 *
 * Success criteria: Position changes to Varrock area
 */

import { runTest, sleep } from './utils/test-runner';
import { Items, Spells } from './utils/save-generator';

const MAGIC_TAB = 6;

runTest({
    name: 'Teleport Test (SDK)',
    saveConfig: {
        position: { x: 3222, z: 3218 },  // Lumbridge
        skills: { Magic: 50 },  // Need 25, using 50 to ensure enough
        inventory: [
            { id: Items.FIRE_RUNE, count: 10 },
            { id: Items.AIR_RUNE, count: 30 },
            { id: Items.LAW_RUNE, count: 10 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk }) => {
    console.log('Goal: Cast Varrock Teleport');

    // Wait for save file to load (position should be at Lumbridge, not 0,0)
    await sdk.waitForCondition(s => {
        const x = s.player?.worldX ?? 0;
        const z = s.player?.worldZ ?? 0;
        return x > 0 && z > 0;
    }, 5000);
    await sleep(500);  // Extra delay for inventory/skills to sync

    const startX = sdk.getState()?.player?.worldX ?? 0;
    const startZ = sdk.getState()?.player?.worldZ ?? 0;
    console.log(`Starting position: (${startX}, ${startZ})`);

    const magicSkill = sdk.getSkill('Magic');
    console.log(`Magic level: ${magicSkill?.baseLevel}, xp: ${magicSkill?.experience}`);
    console.log(`Runes: ${sdk.getInventory().map(i => `${i.name}(${i.count})`).join(', ')}`);

    // Switch to magic tab and cast teleport
    console.log('Switching to magic tab...');
    await sdk.sendSetTab(MAGIC_TAB);
    await sleep(300);

    console.log('Casting Varrock Teleport...');
    await sdk.sendClickComponent(Spells.VARROCK_TELEPORT);

    // Wait for position to change
    try {
        await sdk.waitForCondition(s => {
            const x = s.player?.worldX ?? 0;
            const z = s.player?.worldZ ?? 0;
            const dist = Math.abs(x - startX) + Math.abs(z - startZ);
            return dist > 50;
        }, 5000);

        const endX = sdk.getState()?.player?.worldX ?? 0;
        const endZ = sdk.getState()?.player?.worldZ ?? 0;
        console.log(`Teleported to: (${endX}, ${endZ})`);
        console.log('SUCCESS: Position changed significantly');
        return true;
    } catch {
        const endX = sdk.getState()?.player?.worldX ?? 0;
        const endZ = sdk.getState()?.player?.worldZ ?? 0;
        console.log(`Position after: (${endX}, ${endZ})`);
        console.log('FAILED: Did not teleport');
        return false;
    }
});
