// Differential test: ReachProbe vs the router it predicts.
//
// The probe only earns its keep if `reachable: false` means exactly "the OP
// dispatch would have returned cant_reach". So the oracle is the real thing -
// movement.ts tryMoveTo, the verbatim port of Client.tryMove that every
// interaction path actually calls - and the assertion is agreement on every
// tile of a swept window, not on a couple of hand-picked cases.
//
// A false positive here is the dangerous direction: it puts `reachable: true` on
// a target that then silently no-ops, which is the bug this whole feature exists
// to kill. Sweeping every tile is what catches it.

import { describe, expect, test } from 'bun:test';

import CollisionMap, { BuildArea } from '#/dash3d/CollisionMap.js';
import { LocAngle } from '#/dash3d/LocAngle.js';
import { LocShape } from '#/dash3d/LocShape.js';

import { tryMoveTo } from '../lite/movement.js';
import { ReachProbe, entityRule, tileRule } from './reach.js';

/** Everything tryMoveTo and ReachProbe touch, and nothing else. */
function fakeClient(map: CollisionMap, srcX: number, srcZ: number) {
    return {
        collision: [map, null, null, null],
        minusedlevel: 0,
        localPlayer: { routeX: Int32Array.of(srcX), routeZ: Int32Array.of(srcZ) },
        mapBuildBaseX: 0,
        mapBuildBaseZ: 0,
        minimapFlagX: 0,
        minimapFlagZ: 0,
        ensureCollision(): void {},
        // The oracle writes a MOVE_OPCLICK when it succeeds; we only care that it
        // got that far, so the packet goes in the bin.
        out: { p1Enc(): void {}, p1(): void {}, p2(): void {} }
    };
}

interface Rule {
    dx: number;
    dz: number;
    locWidth: number;
    locLength: number;
    locAngle: number;
    locShape: number;
    forceapproach: number;
}

function oracle(client: ReturnType<typeof fakeClient>, rule: Rule): boolean {
    return tryMoveTo(client as any, rule.dx, rule.dz, rule.locWidth, rule.locLength, rule.locAngle, rule.locShape, rule.forceapproach);
}

/**
 * Sweep a window and require probe === router on every tile, returning what the
 * router said so each scenario can also assert the map is shaped as intended.
 * (A test where everything is unreachable would otherwise pass trivially.)
 */
function sweep(map: CollisionMap, srcX: number, srcZ: number, x0: number, x1: number, z0: number, z1: number, rule: (x: number, z: number) => Rule) {
    const client = fakeClient(map, srcX, srcZ);
    const probe = new ReachProbe(client as any);
    const mismatches: string[] = [];
    let reachable = 0;
    let unreachable = 0;

    for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
            const r = rule(x, z);
            // Fresh client per oracle call: tryMoveTo is stateful about nothing
            // we care about, but the probe caches, and we want the cache
            // exercised across the whole sweep rather than reset each time.
            const expected = oracle(client, r);
            const actual = probe.canReach(r);
            if (expected !== actual) {
                mismatches.push(`(${x},${z}) router=${expected} probe=${actual}`);
            }
            if (expected) reachable++;
            else unreachable++;
        }
    }

    return { mismatches, reachable, unreachable };
}

/** Open 104x104 with a solid ring wall around [x0,x1]x[z0,z1]; `gaps` are left open. */
function walledRoom(x0: number, x1: number, z0: number, z1: number, gaps: Array<[number, number]> = []): CollisionMap {
    const map = new CollisionMap();
    const open = new Set(gaps.map(([x, z]) => `${x},${z}`));

    for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
            const onEdge = x === x0 || x === x1 || z === z0 || z === z1;
            if (onEdge && !open.has(`${x},${z}`)) {
                map.blockGround(x, z);
            }
        }
    }
    return map;
}

describe('ReachProbe agrees with the router', () => {
    test('open ground', () => {
        const map = new CollisionMap();
        const { mismatches, reachable } = sweep(map, 50, 50, 40, 60, 40, 60, (x, z) => tileRule(x, z));

        expect(mismatches).toEqual([]);
        expect(reachable).toBe(21 * 21); // nothing blocked, so everything routes
    });

    test('sealed room - the inside is unreachable and the probe knows', () => {
        const map = walledRoom(45, 55, 45, 55);
        const { mismatches, reachable, unreachable } = sweep(map, 30, 30, 44, 56, 44, 56, (x, z) => tileRule(x, z));

        expect(mismatches).toEqual([]);
        // 9x9 interior + the 40 wall tiles themselves are all off limits.
        expect(unreachable).toBe(9 * 9 + 40);
        expect(reachable).toBeGreaterThan(0);
    });

    test('one gap in the wall opens the whole room', () => {
        const sealed = walledRoom(45, 55, 45, 55);
        const doorway = walledRoom(45, 55, 45, 55, [[50, 45]]);

        const before = sweep(sealed, 30, 30, 46, 54, 46, 54, (x, z) => tileRule(x, z));
        const after = sweep(doorway, 30, 30, 46, 54, 46, 54, (x, z) => tileRule(x, z));

        expect(before.mismatches).toEqual([]);
        expect(after.mismatches).toEqual([]);
        expect(before.reachable).toBe(0);
        expect(after.reachable).toBe(9 * 9);
    });

    test('entity footprint - a 2x2 NPC is approachable from any side', () => {
        const map = new CollisionMap();
        // Box the NPC in on three sides so only one approach survives; the
        // 1x1-vs-size distinction is exactly what this is about.
        map.blockGround(49, 50);
        map.blockGround(49, 51);
        map.blockGround(50, 52);
        map.blockGround(51, 52);

        const { mismatches } = sweep(map, 40, 40, 48, 53, 48, 53, (x, z) => entityRule(x, z, 2));
        expect(mismatches).toEqual([]);

        const client = fakeClient(map, 40, 40);
        const probe = new ReachProbe(client as any);
        // The NPC's own tile is walkable and the south/east sides are open.
        expect(probe.canReach(entityRule(50, 50, 2))).toBe(true);
    });

    // The tests above can all be satisfied by standing ON the target tile, which
    // means they never exercise the adjacency strips. A loc blocks its own
    // tiles, so reach there is *only* ever satisfied from beside it - this is
    // the case that actually constrains the reach window.
    test('blocked 1x1 loc - reach comes only from beside it', () => {
        const map = new CollisionMap();
        map.addLoc(50, 50, 1, 1, LocAngle.WEST, false);

        const locAt = (x: number, z: number): Rule => ({ dx: x, dz: z, locWidth: 1, locLength: 1, locAngle: 0, locShape: 0, forceapproach: 0 });

        const { mismatches } = sweep(map, 40, 40, 47, 53, 47, 53, locAt);
        expect(mismatches).toEqual([]);

        const client = fakeClient(map, 40, 40);
        const probe = new ReachProbe(client as any);
        expect(probe.canReach(locAt(50, 50))).toBe(true); // beside it is enough
        expect(oracle(client, locAt(50, 50))).toBe(true);
    });

    test('blocked 2x2 loc walled off on every side', () => {
        const map = new CollisionMap();
        map.addLoc(50, 50, 2, 2, LocAngle.WEST, false);
        // Ring the whole 2x2 so not one approach tile is standable.
        for (let x = 49; x <= 52; x++) {
            map.blockGround(x, 49);
            map.blockGround(x, 52);
        }
        for (let z = 49; z <= 52; z++) {
            map.blockGround(49, z);
            map.blockGround(52, z);
        }

        const rule: Rule = { dx: 50, dz: 50, locWidth: 2, locLength: 2, locAngle: 0, locShape: 0, forceapproach: 0 };
        const client = fakeClient(map, 40, 40);
        const probe = new ReachProbe(client as any);

        expect(oracle(client, rule)).toBe(false);
        expect(probe.canReach(rule)).toBe(false);

        // Punch out one ring tile and both must flip together.
        map.unblockGround(51, 49);
        const opened = fakeClient(map, 40, 40);
        expect(oracle(opened, rule)).toBe(true);
        expect(new ReachProbe(opened as any).canReach(rule)).toBe(true);
    });

    test('blocked loc, each approach side in turn', () => {
        // Walk the open side around the loc: every one of the four strips has to
        // be found, so a reach window missing any edge fails here.
        const sides: Array<[string, number, number]> = [
            ['west', 49, 50],
            ['east', 51, 50],
            ['south', 50, 49],
            ['north', 50, 51]
        ];

        for (const [name, openX, openZ] of sides) {
            const map = new CollisionMap();
            map.addLoc(50, 50, 1, 1, LocAngle.WEST, false);
            for (const [, x, z] of sides) {
                if (x !== openX || z !== openZ) map.blockGround(x, z);
            }
            // Diagonals too - only the one orthogonal side stays open.
            for (const [dx, dz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
                map.blockGround(50 + dx, 50 + dz);
            }

            const rule: Rule = { dx: 50, dz: 50, locWidth: 1, locLength: 1, locAngle: 0, locShape: 0, forceapproach: 0 };
            const client = fakeClient(map, 40, 40);
            expect(`${name}:${oracle(client, rule)}`).toBe(`${name}:true`);
            expect(`${name}:${new ReachProbe(client as any).canReach(rule)}`).toBe(`${name}:true`);
        }
    });

    test('sealed entity - what the Lumbridge castle Men look like', () => {
        const map = walledRoom(45, 55, 45, 55);
        const client = fakeClient(map, 30, 30);
        const probe = new ReachProbe(client as any);

        const inside = entityRule(50, 50, 1);
        expect(oracle(client, inside)).toBe(false); // the router refuses...
        expect(probe.canReach(inside)).toBe(false); // ...and so does the probe

        const outside = entityRule(35, 35, 1);
        expect(oracle(client, outside)).toBe(true);
        expect(probe.canReach(outside)).toBe(true);
    });

    test('a diagonal pinch is not a path', () => {
        // (51,51) is open but every orthogonal neighbour is blocked, so the only
        // way in is a diagonal squeeze between two blocked tiles. The router
        // refuses that - each diagonal expansion requires both of the tiles it
        // cuts past to be open - and the probe carries the same guards. Without
        // them it would call this reachable, which is the false positive that
        // puts `reachable: true` on a target the dispatch then silently drops.
        const map = new CollisionMap();
        map.blockGround(51, 50);
        map.blockGround(50, 51);
        map.blockGround(52, 51);
        map.blockGround(51, 52);

        const client = fakeClient(map, 40, 40);
        const probe = new ReachProbe(client as any);

        expect(oracle(client, tileRule(51, 51))).toBe(false);
        expect(probe.canReach(tileRule(51, 51))).toBe(false);

        // The tiles diagonally around the pinch are all reachable normally, so
        // this isn't just a walled-off corner of the map.
        expect(probe.canReach(tileRule(50, 50))).toBe(true);
        expect(probe.canReach(tileRule(52, 52))).toBe(true);

        // Open one orthogonal neighbour and it becomes reachable for both.
        map.unblockGround(51, 50);
        const opened = fakeClient(map, 40, 40);
        expect(oracle(opened, tileRule(51, 51))).toBe(true);
        expect(new ReachProbe(opened as any).canReach(tileRule(51, 51))).toBe(true);
    });

    test('wall reach rule - a door is reachable from its own side', () => {
        const wallRule = (x: number, z: number): Rule => ({
            dx: x,
            dz: z,
            locWidth: 0,
            locLength: 0,
            locAngle: LocAngle.WEST,
            locShape: LocShape.WALL_STRAIGHT + 1,
            forceapproach: 0
        });

        const map = new CollisionMap();
        map.addWall(50, 50, LocShape.WALL_STRAIGHT, LocAngle.WEST, false);

        const { mismatches, reachable } = sweep(map, 40, 40, 47, 53, 47, 53, wallRule);
        expect(mismatches).toEqual([]);
        expect(reachable).toBeGreaterThan(0);

        // The sweep above can be satisfied by standing on the wall's own tile,
        // which never exercises testWall. Make that tile unstandable - the shape
        // of a gate in a sealed wall, where you interact from outside - so reach
        // is only ever satisfied by the wall rule itself.
        const gated = new CollisionMap();
        gated.addWall(50, 50, LocShape.WALL_STRAIGHT, LocAngle.WEST, false);
        gated.blockGround(50, 50);

        const client = fakeClient(gated, 40, 40);
        const probe = new ReachProbe(client as any);

        expect(probe.canReach(tileRule(50, 50))).toBe(false); // can't stand there
        expect(oracle(client, wallRule(50, 50))).toBe(true); // but can reach the wall
        expect(probe.canReach(wallRule(50, 50))).toBe(true);
    });

    test('forceapproach - a loc that refuses every side is unreachable', () => {
        const map = new CollisionMap();
        map.addLoc(50, 50, 1, 1, LocAngle.WEST, false); // blocked, so only the strips can satisfy

        const refusing: Rule = { dx: 50, dz: 50, locWidth: 1, locLength: 1, locAngle: 0, locShape: 0, forceapproach: 0xf };
        const permissive: Rule = { ...refusing, forceapproach: 0 };

        const client = fakeClient(map, 40, 40);
        const probe = new ReachProbe(client as any);

        expect(oracle(client, permissive)).toBe(true);
        expect(probe.canReach(permissive)).toBe(true);

        expect(oracle(client, refusing)).toBe(false);
        expect(probe.canReach(refusing)).toBe(false);
    });
});

describe('ReachProbe caching', () => {
    test('a stale fill is not reused after the player moves', () => {
        const map = walledRoom(45, 55, 45, 55, [[50, 45]]);
        const client = fakeClient(map, 30, 30);
        const probe = new ReachProbe(client as any);

        // Inside the room, reachable the long way round through the doorway.
        expect(probe.canReach(tileRule(50, 50))).toBe(true);

        // Seal the doorway and move the player: both invalidation triggers.
        map.blockGround(50, 45);
        client.localPlayer.routeX[0] = 31;
        probe.invalidate();

        expect(probe.canReach(tileRule(50, 50))).toBe(false);
        expect(oracle(client, tileRule(50, 50))).toBe(false);
    });

    test('a teleport refreshes the fill without an explicit invalidate', () => {
        // invalidate() is the contract, but the cache is also keyed on the
        // player's route tile - so a position change that nobody announced (a
        // teleport, a scene reload) can't serve an answer from the old spot.
        const map = walledRoom(45, 55, 45, 55);
        const client = fakeClient(map, 30, 30);
        const probe = new ReachProbe(client as any);

        expect(probe.canReach(tileRule(50, 50))).toBe(false); // sealed room, from outside
        expect(probe.canReach(tileRule(30, 31))).toBe(true);

        // Teleport inside. No invalidate() call on purpose.
        client.localPlayer.routeX[0] = 50;
        client.localPlayer.routeZ[0] = 50;

        expect(probe.canReach(tileRule(50, 50))).toBe(true); // now standing in it
        expect(probe.canReach(tileRule(30, 31))).toBe(false); // and the outside is sealed off
    });

    test('unavailable without a collision map or a local player', () => {
        const map = new CollisionMap();
        const noMap = { ...fakeClient(map, 30, 30), collision: [null, null, null, null] };
        expect(new ReachProbe(noMap as any).available()).toBe(false);

        const noPlayer = { ...fakeClient(map, 30, 30), localPlayer: null };
        expect(new ReachProbe(noPlayer as any).available()).toBe(false);

        // Off the build area entirely - a scene that hasn't loaded yet.
        const offscene = fakeClient(map, -1, BuildArea.SIZE + 5);
        expect(new ReachProbe(offscene as any).available()).toBe(false);
    });
});
