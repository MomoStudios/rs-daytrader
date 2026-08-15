// reach.ts - "could the router actually get me there?", answered at selection
// time instead of at dispatch time. StateCollector stamps the answer onto every
// published npc/player/loc/ground item as `reachable`.
//
// It matters because a failed route is silent. 274 runs clientRoutefinder=true,
// so every OP* must be preceded by a client-computed MOVE_OPCLICK; when the
// route fails the interaction methods return `cant_reach` before writing a byte,
// the server never sees the attempt, and nobody says anything. Picking a
// reachable target up front is the only fix - the packet cannot be forced out.
//
// Two invariants hold this together.
//
// 1. Fidelity. The neighbour expansion below is copied from
//    Client.tryMove/movement.ts route() step for step, and the reach predicates
//    are applied in the same order. A `reachable: true` that the dispatch then
//    rejects is a bug in this file - reach.test.ts sweeps for exactly that.
// 2. Cost. The router's BFS already knows the cost to every tile in the 104x104
//    build area, so the fill runs once per snapshot and every candidate is
//    answered from it. Per-candidate work is only the reach test, bounded by the
//    footprint grown by one - 9 tiles for an NPC.

import CollisionMap, { BuildArea } from '#/dash3d/CollisionMap.js';
import { CollisionFlag } from '#/dash3d/CollisionFlag.js';
import { LocShape } from '#/dash3d/LocShape.js';
import { LocAngle } from '#/dash3d/LocAngle.js';
import LocType from '#/config/LocType.js';

const SIZE = BuildArea.SIZE;
const TILES = SIZE * SIZE;

/** The arguments tryMoveTo/tryMove takes, minus the source and the packet type. */
interface ReachRule {
    dx: number;
    dz: number;
    locWidth: number;
    locLength: number;
    locAngle: number;
    locShape: number;
    forceapproach: number;
}

/**
 * Reach rule for an NPC or player, matching what the OP* dispatch paths send.
 * Size comes from NpcType so a 2x2 NPC is approachable from any of its sides.
 * The dispatch sites must pass the same value - see invariant 1 above.
 */
export function entityRule(routeX: number, routeZ: number, size: number): ReachRule {
    const n = size > 0 ? size : 1;
    return { dx: routeX, dz: routeZ, locWidth: n, locLength: n, locAngle: 0, locShape: 0, forceapproach: 0 };
}

/** Reach rule for a ground item: OPOBJ routes with a 0x0 footprint, i.e. stand on the tile. */
export function tileRule(sceneX: number, sceneZ: number): ReachRule {
    return { dx: sceneX, dz: sceneZ, locWidth: 0, locLength: 0, locAngle: 0, locShape: 0, forceapproach: 0 };
}

/**
 * Reach rule for a loc. Port of routeToLoc's shape dispatch: walls and wall
 * decorations get the wall reach test, every other shape gets the rotated
 * footprint plus forceapproach.
 */
export function locRule(sceneX: number, sceneZ: number, locId: number, shape: number, angle: number): ReachRule {
    if (shape === LocShape.CENTREPIECE_STRAIGHT || shape === LocShape.CENTREPIECE_DIAGONAL || shape === LocShape.GROUND_DECOR) {
        const loc = LocType.list(locId);
        const flat = angle === LocAngle.WEST || angle === LocAngle.EAST;
        const width = flat ? loc.width : loc.length;
        const length = flat ? loc.length : loc.width;

        let forceapproach = loc.forceapproach;
        if (angle !== 0) {
            forceapproach = ((forceapproach << angle) & 0xf) + (forceapproach >> (4 - angle));
        }

        return { dx: sceneX, dz: sceneZ, locWidth: width, locLength: length, locAngle: 0, locShape: 0, forceapproach };
    }

    return { dx: sceneX, dz: sceneZ, locWidth: 0, locLength: 0, locAngle: angle, locShape: shape + 1, forceapproach: 0 };
}

/**
 * Structural view of the bits of Client/LiteClient this needs. Both classes
 * satisfy it; the members are private on Client so callers pass it through
 * `as any`, exactly like StateCollector does everywhere else.
 */
export interface ReachClientView {
    collision: (CollisionMap | null)[];
    minusedlevel: number;
    localPlayer: { routeX: Int32Array; routeZ: Int32Array } | null;
    /** Lite only - folds pending door/loc changes into the collision map. */
    ensureCollision?(): void;
    /** Recovers a loc's (shape, angle) from the scene. Private on Client. */
    locSceneInfo?(sceneX: number, sceneZ: number, locId: number): { shape: number; angle: number } | null;
}

export class ReachProbe {
    private readonly client: ReachClientView;

    // Visited set as generation stamps rather than a flag array, so starting a
    // new flood fill costs an increment instead of a 10816-element clear.
    private readonly stamp = new Int32Array(TILES);
    private readonly queue = new Int32Array(TILES);
    private generation = 0;

    // The fill is only valid while the player and the collision map hold still.
    private filledMap: CollisionMap | null = null;
    private filledX = -1;
    private filledZ = -1;
    private valid = false;

    constructor(client: ReachClientView) {
        this.client = client;
    }

    /**
     * Drop the cached fill. Call at snapshot boundaries: the player moves and
     * doors open between ticks, and stale reachability is worse than none.
     */
    invalidate(): void {
        this.valid = false;
    }

    /** True when a flood fill is possible at all (in game, collision map built). */
    available(): boolean {
        return this.fill() !== null;
    }

    canReach(rule: ReachRule): boolean {
        const map = this.fill();
        if (!map) {
            return false;
        }
        return this.test(map, rule);
    }

    canReachEntity(routeX: number, routeZ: number, size: number): boolean {
        return this.canReach(entityRule(routeX, routeZ, size));
    }

    canReachTile(sceneX: number, sceneZ: number): boolean {
        return this.canReach(tileRule(sceneX, sceneZ));
    }

    /** Returns null when the loc's (shape, angle) can't be recovered from the scene. */
    canReachLoc(sceneX: number, sceneZ: number, locId: number): boolean | null {
        const info = this.client.locSceneInfo?.(sceneX, sceneZ, locId);
        if (!info) {
            return null;
        }
        return this.canReach(locRule(sceneX, sceneZ, locId, info.shape, info.angle));
    }

    // ------------------------------------------------------------- internals

    /**
     * Flood fill from the player's route tile over the whole build area,
     * memoized until invalidate().
     *
     * This is route() with the early `arrived` breaks removed. Everything else -
     * the eight neighbour expansions, their diagonal corner-cutting guards, the
     * bounds checks - is verbatim. See invariant 1 at the top of the file.
     */
    private fill(): CollisionMap | null {
        this.client.ensureCollision?.();

        const map = this.client.collision?.[this.client.minusedlevel] ?? null;
        const player = this.client.localPlayer;
        if (!map || !player) {
            this.valid = false;
            return null;
        }

        const srcX = player.routeX[0];
        const srcZ = player.routeZ[0];
        if (srcX < 0 || srcZ < 0 || srcX >= SIZE || srcZ >= SIZE) {
            this.valid = false;
            return null;
        }

        if (this.valid && this.filledMap === map && this.filledX === srcX && this.filledZ === srcZ) {
            return map;
        }

        const stamp = this.stamp;
        const queue = this.queue;
        const flags = map.flags;
        const gen = ++this.generation;

        let head = 0;
        let tail = 0;

        stamp[CollisionMap.index(srcX, srcZ)] = gen;
        queue[tail++] = (srcX << 16) | srcZ;

        while (head !== tail) {
            const packed = queue[head++];
            const x = packed >> 16;
            const z = packed & 0xffff;

            let index = CollisionMap.index(x - 1, z);
            if (x > 0 && stamp[index] !== gen && (flags[index] & CollisionFlag.PL_WALK_E) === CollisionFlag._OPEN) {
                stamp[index] = gen;
                queue[tail++] = ((x - 1) << 16) | z;
            }

            index = CollisionMap.index(x + 1, z);
            if (x < SIZE - 1 && stamp[index] !== gen && (flags[index] & CollisionFlag.PL_WALK_W) === CollisionFlag._OPEN) {
                stamp[index] = gen;
                queue[tail++] = ((x + 1) << 16) | z;
            }

            index = CollisionMap.index(x, z - 1);
            if (z > 0 && stamp[index] !== gen && (flags[index] & CollisionFlag.PL_WALK_N) === CollisionFlag._OPEN) {
                stamp[index] = gen;
                queue[tail++] = (x << 16) | (z - 1);
            }

            index = CollisionMap.index(x, z + 1);
            if (z < SIZE - 1 && stamp[index] !== gen && (flags[index] & CollisionFlag.PL_WALK_S) === CollisionFlag._OPEN) {
                stamp[index] = gen;
                queue[tail++] = (x << 16) | (z + 1);
            }

            index = CollisionMap.index(x - 1, z - 1);
            if (
                x > 0 &&
                z > 0 &&
                stamp[index] !== gen &&
                (flags[index] & CollisionFlag.PL_WALK_NE) === 0 &&
                (flags[CollisionMap.index(x - 1, z)] & CollisionFlag.PL_WALK_E) === CollisionFlag._OPEN &&
                (flags[CollisionMap.index(x, z - 1)] & CollisionFlag.PL_WALK_N) === CollisionFlag._OPEN
            ) {
                stamp[index] = gen;
                queue[tail++] = ((x - 1) << 16) | (z - 1);
            }

            index = CollisionMap.index(x + 1, z - 1);
            if (
                x < SIZE - 1 &&
                z > 0 &&
                stamp[index] !== gen &&
                (flags[index] & CollisionFlag.PL_WALK_NW) === 0 &&
                (flags[CollisionMap.index(x + 1, z)] & CollisionFlag.PL_WALK_W) === CollisionFlag._OPEN &&
                (flags[CollisionMap.index(x, z - 1)] & CollisionFlag.PL_WALK_N) === CollisionFlag._OPEN
            ) {
                stamp[index] = gen;
                queue[tail++] = ((x + 1) << 16) | (z - 1);
            }

            index = CollisionMap.index(x - 1, z + 1);
            if (
                x > 0 &&
                z < SIZE - 1 &&
                stamp[index] !== gen &&
                (flags[index] & CollisionFlag.PL_WALK_SE) === 0 &&
                (flags[CollisionMap.index(x - 1, z)] & CollisionFlag.PL_WALK_E) === CollisionFlag._OPEN &&
                (flags[CollisionMap.index(x, z + 1)] & CollisionFlag.PL_WALK_S) === CollisionFlag._OPEN
            ) {
                stamp[index] = gen;
                queue[tail++] = ((x - 1) << 16) | (z + 1);
            }

            index = CollisionMap.index(x + 1, z + 1);
            if (
                x < SIZE - 1 &&
                z < SIZE - 1 &&
                stamp[index] !== gen &&
                (flags[index] & CollisionFlag.PL_WALK_SW) === 0 &&
                (flags[CollisionMap.index(x + 1, z)] & CollisionFlag.PL_WALK_W) === CollisionFlag._OPEN &&
                (flags[CollisionMap.index(x, z + 1)] & CollisionFlag.PL_WALK_S) === CollisionFlag._OPEN
            ) {
                stamp[index] = gen;
                queue[tail++] = ((x + 1) << 16) | (z + 1);
            }
        }

        this.filledMap = map;
        this.filledX = srcX;
        this.filledZ = srcZ;
        this.valid = true;
        return map;
    }

    /**
     * Does any tile the fill reached satisfy the target's reach rule?
     *
     * Only the footprint grown by one needs checking: testLoc accepts the
     * footprint itself plus the four orthogonal side strips, and
     * testWall/testWDecor only ever accept src tiles one step away in x or z.
     */
    private test(map: CollisionMap, rule: ReachRule): boolean {
        const { dx, dz, locWidth, locLength, locAngle, locShape, forceapproach } = rule;
        const gen = this.generation;

        // A 0x0 footprint (ground items) still needs the destination tile itself
        // considered, which is what the `sx === dx && sz === dz` arm below does.
        const spanX = locWidth > 0 ? locWidth : 1;
        const spanZ = locLength > 0 ? locLength : 1;

        for (let sx = dx - 1; sx <= dx + spanX; sx++) {
            if (sx < 0 || sx >= SIZE) continue;

            for (let sz = dz - 1; sz <= dz + spanZ; sz++) {
                if (sz < 0 || sz >= SIZE) continue;
                if (this.stamp[CollisionMap.index(sx, sz)] !== gen) continue;

                if (sx === dx && sz === dz) {
                    return true;
                }

                if (locShape !== LocShape.WALL_STRAIGHT) {
                    if ((locShape < LocShape.WALLDECOR_STRAIGHT_OFFSET || locShape === LocShape.CENTREPIECE_STRAIGHT) && map.testWall(sx, sz, dx, dz, locShape - 1, locAngle)) {
                        return true;
                    }
                    if (locShape < LocShape.CENTREPIECE_STRAIGHT && map.testWDecor(sx, sz, dx, dz, locShape - 1, locAngle)) {
                        return true;
                    }
                }

                if (locWidth !== 0 && locLength !== 0 && map.testLoc(sx, sz, dx, dz, locWidth, locLength, forceapproach)) {
                    return true;
                }
            }
        }

        return false;
    }
}
