/**
 * Test runner utilities for SDK-based tests.
 * Provides common patterns to reduce boilerplate across test files.
 */

import { launchBotWithSDK, sleep, type SDKSession } from './browser';
import { generateSave, type SaveConfig, type TestPreset } from './save-generator';
import type { BotSDK } from '../..';
import type { BotActions } from '../../actions';

// ============================================================================
// Test Runner
// ============================================================================

export interface TestConfig {
    /** Test name for logging */
    name: string;
    /** Bot name (auto-generated if not provided) */
    botName?: string;
    /** Pre-defined test preset from save-generator */
    preset?: TestPreset;
    /** Custom save configuration (used if preset not provided) */
    saveConfig?: SaveConfig;
    /** Launch options for the browser session */
    launchOptions?: {
        skipTutorial?: boolean;
        headless?: boolean;
    };
}

export interface TestContext {
    sdk: BotSDK;
    bot: BotActions;
    session: SDKSession;
}

export type TestFn = (ctx: TestContext) => Promise<boolean>;

/**
 * Run a test with automatic setup and cleanup.
 *
 * Handles:
 * - Save file generation (from preset or custom config)
 * - Browser/SDK session launch
 * - Cleanup on success or failure
 * - Exit code management
 *
 * @example
 * ```ts
 * runTest({
 *   name: 'Mining Test',
 *   preset: TestPresets.MINER_AT_VARROCK,
 * }, async ({ sdk, bot }) => {
 *   const initialLevel = sdk.getSkill('Mining')?.baseLevel ?? 1;
 *   // ... test logic ...
 *   return currentLevel > initialLevel;
 * });
 * ```
 */
export function runTest(config: TestConfig, testFn: TestFn): void {
    const botName = config.botName ?? generateBotName(config.name);

    const execute = async (): Promise<boolean> => {
        console.log(`=== ${config.name} ===`);

        // Generate save file if preset or config provided
        if (config.preset || config.saveConfig) {
            console.log(`Creating save file for '${botName}'...`);
            await generateSave(botName, config.preset ?? config.saveConfig!);
        }

        let session: SDKSession | null = null;

        try {
            session = await launchBotWithSDK(botName, config.launchOptions);
            const { sdk, bot } = session;
            console.log(`Bot '${session.botName}' ready!`);

            const state = sdk.getState();
            console.log(`Position: (${state?.player?.worldX}, ${state?.player?.worldZ})`);

            return await testFn({ sdk, bot, session });
        } finally {
            if (session) {
                await session.cleanup();
            }
        }
    };

    execute()
        .then(ok => {
            console.log(ok ? '\nPASSED' : '\nFAILED');
            process.exit(ok ? 0 : 1);
        })
        .catch(e => {
            console.error('Fatal:', e);
            process.exit(1);
        });
}

function generateBotName(testName: string): string {
    const prefix = testName.toLowerCase().replace(/[^a-z]/g, '').slice(0, 4) || 'test';
    const suffix = Math.random().toString(36).slice(2, 5);
    return `${prefix}${suffix}`;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Dismiss any open dialog by clicking the first option.
 * Returns true if a dialog was dismissed.
 *
 * @example
 * ```ts
 * if (await dismissDialog(sdk)) {
 *   continue; // Dialog was handled, proceed to next iteration
 * }
 * ```
 */
export async function dismissDialog(sdk: BotSDK, optionIndex: number = 0): Promise<boolean> {
    const state = sdk.getState();
    if (state?.dialog?.isOpen) {
        await sdk.sendClickDialog(optionIndex);
        await sleep(300);
        return true;
    }
    return false;
}

// Re-export sleep for convenience
export { sleep } from './browser';
