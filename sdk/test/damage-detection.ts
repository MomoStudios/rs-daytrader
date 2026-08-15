#!/usr/bin/env bun
/**
 * Damage Detection and Eating Test (SDK)
 * Test that a player with 99 HP can detect when they take damage
 * and respond by eating food to heal.
 *
 * Location: Dark Wizards south of Varrock - aggressive mages that
 * cast spells and are notorious for killing unprepared players.
 *
 * Success criteria:
 * 1. Start with 99 HP near Dark Wizards
 * 2. Get attacked by aggressive dark wizards (or attack them)
 * 3. Detect HP has dropped from their magic attacks
 * 4. Eat food to heal
 * 5. Verify HP increased after eating
 */

import { runTest, dismissDialog, sleep } from './utils/test-runner';
import { Items } from './utils/save-generator';
import { BotActions } from '../actions';
import type { InventoryItem } from '../types';

const MAX_TURNS = 100;
const DARK_WIZARDS_AREA = { x: 3230, z: 3370 };

function findFood(inventory: InventoryItem[]): InventoryItem | null {
    const foodNames = [
        'bread', 'meat', 'chicken', 'beef', 'shrimp', 'anchovies',
        'sardine', 'herring', 'trout', 'salmon', 'tuna', 'lobster',
        'cake', 'pie', 'pizza', 'cheese', 'cabbage', 'cooked'
    ];
    return inventory.find(item =>
        foodNames.some(food => item.name.toLowerCase().includes(food))
    ) ?? null;
}

runTest({
    name: 'Damage Detection and Eating Test (SDK)',
    saveConfig: {
        position: DARK_WIZARDS_AREA,
        skills: {
            Hitpoints: 99,
            Attack: 5,
            Strength: 5,
            Defence: 5,
        },
        inventory: [
            { id: Items.BREAD, count: 10 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk , bot}) => {
    console.log('Goal: Detect damage and eat food to heal');

    // Wait for state to fully load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0 && s.inventory.length > 0, 10000);
    await sleep(500);

    // Get initial HP
    const hpSkill = sdk.getSkill('Hitpoints');
    const maxHp = hpSkill?.baseLevel ?? 10;
    let currentHp = hpSkill?.level ?? 10;
    console.log(`Initial HP: ${currentHp}/${maxHp}`);

    if (maxHp < 50) {
        console.log(`WARNING: Expected high HP, got ${maxHp}`);
    }

    let damageTaken = false;
    let foodEaten = false;
    let hpAfterEating = 0;
    let lowestHp = currentHp;

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        // Check current HP
        const hp = sdk.getSkill('Hitpoints');
        currentHp = hp?.level ?? 10;

        // Track lowest HP
        if (currentHp < lowestHp) {
            lowestHp = currentHp;
        }

        // Check if we've taken damage
        if (currentHp < maxHp && !damageTaken) {
            damageTaken = true;
            console.log(`Turn ${turn}: DAMAGE DETECTED! HP dropped to ${currentHp}/${maxHp}`);
        }

        // If we've taken damage, eat food
        if (damageTaken && !foodEaten && currentHp < maxHp - 10) {
            const food = findFood(sdk.getInventory());
            if (food) {
                const hpBeforeEating = currentHp;
                console.log(`Turn ${turn}: Eating ${food.name} (x${food.count}) at HP ${currentHp}`);

                const result = await bot.eatFood(food);
                if (result.success) {
                    hpAfterEating = sdk.getSkill('Hitpoints')?.level ?? 10;
                    foodEaten = true;
                    console.log(`Turn ${turn}: ATE FOOD! HP: ${hpBeforeEating} -> ${hpAfterEating} (+${result.hpGained} HP)`);
                } else {
                    console.log(`Turn ${turn}: Eating failed: ${result.message}`);
                }
            }
        }

        // Success condition: took damage AND ate food AND healed
        if (damageTaken && foodEaten && hpAfterEating > lowestHp) {
            console.log(`\n=== SUCCESS ===`);
            console.log(`- Started with ${maxHp} HP`);
            console.log(`- Took damage, HP dropped to ${lowestHp}`);
            console.log(`- Ate food and healed to ${hpAfterEating}`);
            return true;
        }

        // Handle dialogs
        if (await dismissDialog(sdk)) {
            continue;
        }

        // Progress logging
        if (turn % 20 === 0) {
            console.log(`Turn ${turn}: HP=${currentHp}/${maxHp}, damage=${damageTaken}, ate=${foodEaten}`);
        }

        // Dark wizards are aggressive - just wait for them to attack us
        if (!damageTaken && turn % 15 === 0) {
            console.log(`Turn ${turn}: Waiting for dark wizards to attack...`);
        }

        await sleep(600);
    }

    // Final results
    console.log(`\n=== Results ===`);
    console.log(`Max HP: ${maxHp}`);
    console.log(`Lowest HP reached: ${lowestHp}`);
    console.log(`Damage taken: ${damageTaken}`);
    console.log(`Food eaten: ${foodEaten}`);
    console.log(`HP after eating: ${hpAfterEating}`);

    // Partial success if we at least took damage
    if (damageTaken) {
        if (foodEaten) {
            console.log('SUCCESS: Detected damage and ate food');
            return true;
        } else {
            console.log('PARTIAL: Detected damage but did not eat food');
        }
    } else {
        console.log('FAILED: Did not take any damage');
    }

    return damageTaken && foodEaten;
});
