#!/usr/bin/env bun
/**
 * Tutorial Exit Test (SDK)
 * Succeeds when reaching Lumbridge (x >= 3200)
 */

import { launchBotWithSDK, type SDKSession } from './utils/browser';

const BOT_NAME = process.env.BOT_NAME;

async function runTest(): Promise<boolean> {
    console.log('=== Tutorial Exit Test (SDK) ===');

    let session: SDKSession | null = null;

    try {
        // launchBotWithSDK handles everything: browser, SDK, tutorial skip
        session = await launchBotWithSDK(BOT_NAME);
        console.log(`Bot '${session.botName}' ready in Lumbridge!`);

        // Verify we're out of tutorial
        const state = session.sdk.getState();
        const worldX = state?.player?.worldX ?? 0;
        console.log(`Position: (${worldX}, ${state?.player?.worldZ ?? 0})`);

        return worldX >= 3200;
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
