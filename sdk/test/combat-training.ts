#!/usr/bin/env bun
/**
 * Combat Training Test (SDK)
 * Train combat skills by fighting NPCs.
 * Success: Gain at least 1 level in Attack, Strength, AND Defence
 */

import { launchBotWithSDK, sleep, type SDKSession } from './utils/browser';
import type { NearbyNpc, InventoryItem } from '../types';

const HEALTH_THRESHOLD = 10;
const BLOCKED_NPC_COOLDOWN_TICKS = 10; // How long to avoid an NPC after "someone else is fighting" message

export interface CombatTrainingOptions {
    durationSeconds?: number;  // 0 = use turn-based (500 turns max)
    logPrefix?: string;        // Prefix for log messages
}

/**
 * Run combat training bot on an existing session.
 * Exported for use by loadtest.ts
 */
export async function runCombatTrainingBot(
    session: SDKSession,
    options: CombatTrainingOptions = {}
): Promise<boolean> {
    const { sdk, bot } = session;
    const durationSeconds = options.durationSeconds ?? 0;
    const logPrefix = options.logPrefix ?? '';
    const maxTurns = durationSeconds > 0 ? 100000 : 500;

    const log = (msg: string) => console.log(`${logPrefix}${logPrefix ? ' ' : ''}${msg}`);

    // Track NPCs that are being fought by other players (npcIndex -> tick when blocked)
    const blockedNpcs = new Map<number, number>();

    // Record initial combat levels
    const initialAtk = sdk.getSkill('Attack')?.baseLevel ?? 1;
    const initialStr = sdk.getSkill('Strength')?.baseLevel ?? 1;
    const initialDef = sdk.getSkill('Defence')?.baseLevel ?? 1;
    log(`Initial levels: Atk=${initialAtk}, Str=${initialStr}, Def=${initialDef}`);

    // Equip weapon - prefer sword over axe
    const sword = sdk.getInventory().find(i =>
        /sword|scimitar|dagger/i.test(i.name)
    );
    const weapon = sword ?? sdk.getInventory().find(i =>
        /axe|mace/i.test(i.name) && !/pickaxe/i.test(i.name)
    );
    if (weapon) {
        log(`Equipping ${weapon.name}`);
        await bot.equipItem(weapon);
        await sleep(500);
    }

    // Helper to get style index for a skill from current weapon's styles
    const getStyleForSkill = (skill: string): number | null => {
        const styleState = sdk.getState()?.combatStyle;
        if (!styleState) return null;
        // A controlled style trains three skills at once, so prefer a style
        // dedicated to the one we want and fall back to a shared style (a spear
        // only has those).
        const trains = (s: { trainsSkills: string[] }) =>
            s.trainsSkills.some(trained => trained.toLowerCase() === skill.toLowerCase());
        const match = styleState.styles.find(s => trains(s) && s.trainsSkills.length === 1)
            ?? styleState.styles.find(trains);
        return match?.index ?? null;
    };

    // Set initial combat style - start with Strength
    await sleep(300);  // Wait for weapon equip to update styles
    const styleState = sdk.getState()?.combatStyle;
    if (styleState) {
        log(`Combat styles: ${styleState.styles.map(s => `${s.index}:${s.name}(${s.trainsSkills.join('+') || 'unknown'})`).join(', ')}`);
    }

    let currentTrainingSkill = 'Strength';
    const strStyle = getStyleForSkill('Strength');
    if (strStyle !== null) {
        log(`Setting combat style to train ${currentTrainingSkill} (style ${strStyle})`);
        await sdk.sendSetCombatStyle(strStyle);
    }

    // Walk east towards goblins/spiders area for more targets
    const state0 = sdk.getState();
    const startX = state0?.player?.worldX ?? 3222;
    const startZ = state0?.player?.worldZ ?? 3218;
    log(`Walking east to goblin/spider area...`);
    await bot.walkTo(startX + 15, startZ);  // Walk ~15 tiles east
    await sleep(2000);

    let kills = 0;
    let foodEaten = 0;
    let lastAtkLevel = initialAtk;
    let lastStrLevel = initialStr;
    let lastDefLevel = initialDef;
    let lastAttackedNpcIndex: number | null = null;

    const startTime = Date.now();
    const useDuration = durationSeconds > 0;
    const endTime = startTime + durationSeconds * 1000;

    // Helper to find best attackable NPC
    const findTarget = (npcs: NearbyNpc[], currentTick: number): NearbyNpc | null => {
        const targetNames = ['goblin', 'spider', 'man', 'woman', 'rat', 'guard', 'chicken'];

        // Filter to only attackable NPCs that aren't blocked
        const attackableNpcs = npcs.filter(npc => {
            const hasAttack = npc.optionsWithIndex.some(o =>
                o.text.toLowerCase() === 'attack'
            );
            if (!hasAttack) return false;

            const blockedTick = blockedNpcs.get(npc.index);
            if (blockedTick !== undefined && currentTick - blockedTick <= BLOCKED_NPC_COOLDOWN_TICKS) {
                return false;
            }
            return true;
        });

        // Score NPCs by preference
        const scoreNpc = (npc: NearbyNpc): number => {
            const name = npc.name.toLowerCase();
            let score = 0;
            const nameIndex = targetNames.findIndex(t => name.includes(t));
            if (nameIndex !== -1) {
                score += (targetNames.length - nameIndex) * 1000;
            }
            score += (15 - Math.min(npc.distance, 15)) * 10;
            score += Math.max(0, 20 - npc.combatLevel);
            return score;
        };

        const sorted = attackableNpcs.sort((a, b) => scoreNpc(b) - scoreNpc(a));
        return sorted[0] ?? null;
    };

    for (let turn = 1; turn <= maxTurns; turn++) {
        // Check time limit if using duration mode
        if (useDuration && Date.now() >= endTime) {
            log(`Time limit reached (${durationSeconds}s)`);
            break;
        }

        // Check for success every 10 turns
        if (turn % 10 === 0) {
            const atk = sdk.getSkill('Attack')?.baseLevel ?? 1;
            const str = sdk.getSkill('Strength')?.baseLevel ?? 1;
            const def = sdk.getSkill('Defence')?.baseLevel ?? 1;

            const gainedAtk = atk > initialAtk;
            const gainedStr = str > initialStr;
            const gainedDef = def > initialDef;

            if (gainedAtk && gainedStr && gainedDef && !useDuration) {
                log(`Turn ${turn}: SUCCESS - All 3 combat skills gained!`);
                log(`  Attack: ${initialAtk} -> ${atk}`);
                log(`  Strength: ${initialStr} -> ${str}`);
                log(`  Defence: ${initialDef} -> ${def}`);
                log(`  Kills: ${kills}, Food eaten: ${foodEaten}`);
                return true;
            }

            if (turn % 50 === 0) {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const timeInfo = useDuration ? ` [${elapsed}s/${durationSeconds}s]` : '';
                log(`Turn ${turn}${timeInfo}: Atk=${atk}(+${atk-initialAtk}), Str=${str}(+${str-initialStr}), Def=${def}(+${def-initialDef}), kills=${kills}`);
            }
        }

        // Check for level ups and switch style
        const atk = sdk.getSkill('Attack')?.baseLevel ?? 1;
        const str = sdk.getSkill('Strength')?.baseLevel ?? 1;
        const def = sdk.getSkill('Defence')?.baseLevel ?? 1;

        const leveledUp = atk > lastAtkLevel || str > lastStrLevel || def > lastDefLevel;
        if (leveledUp) {
            lastAtkLevel = atk;
            lastStrLevel = str;
            lastDefLevel = def;

            let nextSkill: string;
            if (currentTrainingSkill === 'Strength') {
                nextSkill = 'Attack';
            } else if (currentTrainingSkill === 'Attack') {
                nextSkill = 'Defence';
            } else {
                nextSkill = 'Strength';
            }

            const nextStyle = getStyleForSkill(nextSkill);
            if (nextStyle !== null) {
                log(`Turn ${turn}: Level up! Switching to ${nextSkill} training (Atk=${atk}, Str=${str}, Def=${def})`);
                await sdk.sendSetCombatStyle(nextStyle);
                currentTrainingSkill = nextSkill;
            }
        }

        // Handle dialogs
        const state = sdk.getState();
        if (state?.dialog.isOpen) {
            await sdk.sendClickDialog(0);
            await sleep(300);
            continue;
        }

        // Check for "I can't reach that" message
        const cantReachMsg = state?.gameMessages.find(m =>
            m.text.toLowerCase().includes("can't reach") ||
            m.text.toLowerCase().includes("cannot reach")
        );
        if (cantReachMsg && cantReachMsg.tick > (state?.tick ?? 0) - 5) {
            const door = sdk.getNearbyLocs().find(loc =>
                /door/i.test(loc.name) && loc.distance <= 3
            );
            if (door) {
                log(`Turn ${turn}: Opening door at (${door.x}, ${door.z})`);
                await bot.openDoor(door);
                await sleep(600);
                continue;
            }
        }

        // Check for "someone else is fighting that" message
        const currentTick = state?.tick ?? 0;
        const someoneElseMsg = state?.gameMessages.find(m =>
            m.text.toLowerCase().includes("someone else is fighting") ||
            m.text.toLowerCase().includes("already under attack")
        );
        if (someoneElseMsg && someoneElseMsg.tick > currentTick - 3 && lastAttackedNpcIndex !== null) {
            log(`Turn ${turn}: NPC ${lastAttackedNpcIndex} is being fought by someone else, blocking`);
            blockedNpcs.set(lastAttackedNpcIndex, currentTick);
            lastAttackedNpcIndex = null;
        }

        // Clean up expired blocked NPCs
        for (const [npcIndex, blockedTick] of blockedNpcs) {
            if (currentTick - blockedTick > BLOCKED_NPC_COOLDOWN_TICKS) {
                blockedNpcs.delete(npcIndex);
            }
        }

        // Check health and eat food if needed
        const hpSkill = sdk.getSkill('Hitpoints');
        const currentHp = hpSkill?.level ?? 10;
        if (currentHp < HEALTH_THRESHOLD) {
            const food = findFood(sdk.getInventory());
            if (food) {
                log(`Turn ${turn}: Eating ${food.name} (hp=${currentHp})`);
                await bot.eatFood(food);
                foodEaten++;
                await sleep(500);
                continue;
            }
        }

        // Find and attack NPC
        const target = findTarget(sdk.getNearbyNpcs(), currentTick);
        if (target) {
            const attackOpt = target.optionsWithIndex.find(o => /attack/i.test(o.text));
            if (attackOpt) {
                if (turn % 20 === 1) {
                    log(`Turn ${turn}: Attacking ${target.name} (lvl=${target.combatLevel}, dist=${target.distance})`);
                }
                try {
                    lastAttackedNpcIndex = target.index;
                    await sdk.sendInteractNpc(target.index, attackOpt.opIndex);
                    kills++;
                } catch (e: any) {
                    log(`Turn ${turn}: Attack failed - ${e.message}`);
                }
                await sleep(1500);
                continue;
            }
        } else if (turn % 20 === 0) {
            const px = state?.player?.worldX ?? 3222;
            const pz = state?.player?.worldZ ?? 3218;
            const dx = Math.floor(Math.random() * 10) - 5;
            const dz = Math.floor(Math.random() * 10) - 5;
            log(`Turn ${turn}: No targets, wandering...`);
            await bot.walkTo(px + dx, pz + dz);
        }

        await sleep(600);
    }

    // Final check
    const finalAtk = sdk.getSkill('Attack')?.baseLevel ?? 1;
    const finalStr = sdk.getSkill('Strength')?.baseLevel ?? 1;
    const finalDef = sdk.getSkill('Defence')?.baseLevel ?? 1;

    log(`--- Combat Training Complete ---`);
    log(`Attack: ${initialAtk} -> ${finalAtk}`);
    log(`Strength: ${initialStr} -> ${finalStr}`);
    log(`Defence: ${initialDef} -> ${finalDef}`);
    log(`Kills: ${kills}, Food eaten: ${foodEaten}`);

    return finalAtk > initialAtk && finalStr > initialStr && finalDef > initialDef;
}

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

// Standalone execution when run directly
async function runStandalone(): Promise<boolean> {
    const BOT_NAME = process.env.BOT_NAME;
    const HEADLESS = process.env.HEADLESS === 'true';
    const USE_SHARED_BROWSER = process.env.USE_SHARED_BROWSER === 'true';
    const DURATION_SECONDS = parseInt(process.env.DURATION_SECONDS || '0', 10);

    console.log('=== Combat Training Test (SDK) ===');
    console.log('Goal: Gain 1 level in Attack, Strength, AND Defence');

    let session: SDKSession | null = null;

    try {
        session = await launchBotWithSDK(BOT_NAME, {
            headless: HEADLESS,
            useSharedBrowser: USE_SHARED_BROWSER
        });
        console.log(`Bot '${session.botName}' ready!`);

        const result = await runCombatTrainingBot(session, {
            durationSeconds: DURATION_SECONDS
        });

        return result;
    } finally {
        if (session) {
            await session.cleanup();
        }
    }
}

// Only run standalone when executed directly (not imported)
const isMainModule = import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith('combat-training.ts');

if (isMainModule) {
    runStandalone()
        .then(ok => {
            console.log(ok ? '\nPASSED' : '\nFAILED');
            process.exit(ok ? 0 : 1);
        })
        .catch(e => {
            console.error('Fatal:', e);
            process.exit(1);
        });
}
