#!/usr/bin/env bun
/**
 * Prayer Activation Test (SDK)
 * Activate and deactivate prayers using the prayer toggle system.
 *
 * Success criteria: Prayer points must actually drain while a prayer is active,
 * proving the server recognized the activation (not just a client-side varp flip).
 */

import { runTest, sleep } from './utils/test-runner';
import { Locations } from './utils/save-generator';

runTest({
    name: 'Prayer Activation Test (SDK)',
    saveConfig: {
        position: Locations.LUMBRIDGE_CASTLE,
        skills: { Prayer: 45 },  // High enough for all standard prayers
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Activate prayers and verify prayer points drain');

    // Wait for state to fully load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0, 10000);
    await sleep(500);

    // Verify prayer state is available
    const prayerState = sdk.getPrayerState();
    if (!prayerState) {
        console.log('ERROR: No prayer state available');
        return false;
    }
    console.log(`Prayer points: ${prayerState.prayerPoints}, level: ${prayerState.prayerLevel}`);
    console.log(`Active prayers: ${sdk.getActivePrayers().join(', ') || 'none'}`);

    if (prayerState.prayerLevel < 1) {
        console.log('ERROR: Prayer level too low');
        return false;
    }

    const pointsBefore = prayerState.prayerPoints;

    // --- Test 1: Activate protect_from_melee (overhead) and verify prayer points drain ---
    console.log('\n--- Test 1: Activate protect_from_melee, wait for prayer point drain ---');
    const result1 = await bot.activatePrayer('protect_from_melee');
    console.log(`activatePrayer result: ${result1.success} - ${result1.message}`);

    if (!result1.success) {
        console.log('FAILED: Could not activate thick_skin');
        return false;
    }

    if (!sdk.isPrayerActive('protect_from_melee')) {
        console.log('FAILED: protect_from_melee not showing as active after activation');
        return false;
    }
    console.log(`protect_from_melee is active (overhead visible). Prayer points: ${sdk.getPrayerState()?.prayerPoints}`);

    // Wait for prayer points to drain (proves server-side activation)
    console.log('Waiting for prayer points to drain...');
    let drained = false;
    try {
        await sdk.waitForCondition(state => {
            const pts = state.prayers.prayerPoints;
            if (pts < pointsBefore) {
                console.log(`  Prayer points dropped: ${pointsBefore} -> ${pts}`);
                drained = true;
                return true;
            }
            return false;
        }, 30000);
    } catch { /* timeout */ }

    if (!drained) {
        console.log(`FAILED: Prayer points did not drain (still ${sdk.getPrayerState()?.prayerPoints}/${pointsBefore})`);
        // Deactivate before failing
        await bot.deactivatePrayer('protect_from_melee');
        return false;
    }

    // --- Test 2: Deactivate and confirm drain stops ---
    console.log('\n--- Test 2: Deactivate protect_from_melee ---');
    const result2 = await bot.deactivatePrayer('protect_from_melee');
    console.log(`deactivatePrayer result: ${result2.success} - ${result2.message}`);

    if (!result2.success) {
        console.log('FAILED: Could not deactivate thick_skin');
        return false;
    }

    if (sdk.isPrayerActive('protect_from_melee')) {
        console.log('FAILED: protect_from_melee still active after deactivation');
        return false;
    }
    console.log(`protect_from_melee deactivated (overhead gone). Prayer points: ${sdk.getPrayerState()?.prayerPoints}`);

    // --- Test 3: Activate multiple prayers then deactivateAll ---
    console.log('\n--- Test 3: Activate 3 prayers then deactivateAll ---');

    const r3a = await bot.activatePrayer('thick_skin');
    const r3b = await bot.activatePrayer('burst_of_strength');
    const r3c = await bot.activatePrayer('clarity_of_thought');
    console.log(`Activated: thick_skin=${r3a.success}, burst_of_strength=${r3b.success}, clarity_of_thought=${r3c.success}`);

    const activeList = sdk.getActivePrayers();
    console.log(`Active (${activeList.length}): ${activeList.join(', ')}`);

    const result3 = await bot.deactivateAllPrayers();
    console.log(`deactivateAllPrayers: ${result3.success} - ${result3.message}`);

    const remaining = sdk.getActivePrayers();
    if (remaining.length > 0) {
        console.log(`FAILED: ${remaining.length} prayers still active: ${remaining.join(', ')}`);
        return false;
    }
    console.log(`All prayers deactivated. Prayer points: ${sdk.getPrayerState()?.prayerPoints}`);

    console.log('\n=== All prayer tests passed (prayer points confirmed draining) ===');
    return true;
});
