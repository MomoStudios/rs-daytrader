/**
 * Logic test for findNearbyLoc's withOption filter - no bot required.
 *
 * Overlapping duplicate locs are real: the Lumbridge furnace pairs an inert,
 * option-less "Furnace" with the one offering Smelt, and the inert one often
 * wins plain name matching on distance - dead-ending interactLoc with
 * "No matching option on Furnace" while a usable furnace stands 1 tile away.
 */

import { describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import type { BotWorldState, NearbyLoc } from '../types';

function makeLoc(partial: Partial<NearbyLoc>): NearbyLoc {
    return {
        id: 2781,
        name: 'Furnace',
        x: 0,
        z: 0,
        distance: 0,
        optionsWithIndex: [],
        ...partial,
    } as NearbyLoc;
}

function mountSdk(locs: NearbyLoc[]): BotSDK {
    const sdk = new BotSDK({ botUsername: 'test' });
    (sdk as any).state = { nearbyLocs: locs } as unknown as BotWorldState;
    return sdk;
}

describe('findNearbyLoc({ withOption })', () => {
    // Nearest-first list order, inert duplicate first - the reported trap.
    const inert = makeLoc({ x: 3225, z: 3256, distance: 1, optionsWithIndex: [] });
    const smeltable = makeLoc({ x: 3226, z: 3255, distance: 2, optionsWithIndex: [{ text: 'Smelt', opIndex: 2 }] });

    test('plain matching still returns the nearer, inert duplicate', () => {
        const sdk = mountSdk([inert, smeltable]);
        expect(sdk.findNearbyLoc(/furnace/i)).toBe(inert);
    });

    test('withOption skips duplicates that do not offer the option', () => {
        const sdk = mountSdk([inert, smeltable]);
        expect(sdk.findNearbyLoc(/furnace/i, { withOption: /smelt/i })).toBe(smeltable);
    });

    test('string option filters case-insensitively', () => {
        const sdk = mountSdk([inert, smeltable]);
        expect(sdk.findNearbyLoc(/furnace/i, { withOption: 'SMELT' })).toBe(smeltable);
    });

    test('returns null when nothing offers the option', () => {
        const sdk = mountSdk([inert]);
        expect(sdk.findNearbyLoc(/furnace/i, { withOption: /smelt/i })).toBeNull();
    });

    test('a stateful /g regex cannot alternate matches across calls', () => {
        const sdk = mountSdk([inert, smeltable]);
        const sticky = /smelt/gi;
        expect(sdk.findNearbyLoc(/furnace/i, { withOption: sticky })).toBe(smeltable);
        expect(sdk.findNearbyLoc(/furnace/i, { withOption: sticky })).toBe(smeltable);
    });
});
