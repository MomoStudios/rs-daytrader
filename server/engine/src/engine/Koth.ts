import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import Player from '#/engine/entity/Player.js';
import { Visibility } from '#/network/rsbuf/index.js';
import Environment from '#/util/Environment.js';

export type KothCaptureEvent = {
    timestamp: number;
    profile: string;
    username: string;
    combat_level: number;
    contenders: number;
    loadout: string;
};

// King of the Hill at the Demonic Ruins (level ~46 wilderness, mapsquare 51_60).
// The polygon is traced from the egyptian_wall_2 / egypt_crumblywall locs in
// server/content/maps/m51_60.jm2 — the L-shaped main enclosure plus the
// cross-shaped western annex and its corridor. Every edge follows the INTERIOR
// face of its wall line, so tiles on the outside face of a wall (e.g. hugging
// the north wall from z3892, or the east wall from x3293) never count.
// Vertices are tile-corner coords; the final edge back to the first vertex is the
// crumbled diagonal at the southwest corner.
const KOTH_LEVEL: number = 0;
const KOTH_POLYGON: [number, number][] = [
    [3286.5, 3879], // SW, south wall start (z3879 wall tiles are interior-side, they count)
    [3290, 3879], // SE of the southern chamber, at the x3290 wall's interior face
    [3290, 3883], // up the x3290 wall to the z3883 wall row
    [3293, 3883], // east along the z3883 wall's interior face (SE cut pocket is outside)
    [3293, 3892], // up the x3293 east wall's interior face (z3885-3886 door tiles excluded)
    [3287, 3892], // west along the z3892 north wall's interior face
    [3287, 3889], // down the x3287 wall's interior face (NW door tile 3286,3889 excluded)
    [3285, 3889], // west along the z3889 wall (tiles z3888 south of it count)
    [3285, 3887], // down to the corridor's NE corner
    [3283, 3887], // west along the corridor's north wall (x3283-3284/z3886 inside)
    [3283, 3888], // up the annex's NE inner corner
    [3281, 3888], // west along the annex's north stub (x3281-3282/z3887 inside)
    [3281, 3887], // down the north stub's west wall
    [3280, 3887], // step out to the annex's west arm
    [3280, 3885], // down the x3280 west wall
    [3281, 3885], // east under the west arm
    [3281, 3884], // down the south stub's west wall
    [3283, 3884], // east along the annex's south stub (x3281-3282/z3884 inside)
    [3283, 3885], // up the annex's SE inner corner
    [3285, 3885], // east along the corridor's south wall, rejoining the x3285 line
    [3285, 3880.5] // down to the SW diagonal; half-tile offsets keep the (unwalkable)
    // diagonal wall tiles inside while the corner notch tile (3285,3879) tests outside
];

const CAPTURE_INTERVAL_MS: number = 60_000;

// crown announcements are local, not server-wide: only players within 3 zones
// (3 x 8 tiles, Chebyshev) of the ruins hear about a new king
const ANNOUNCE_CENTER_X: number = 3289;
const ANNOUNCE_CENTER_Z: number = 3886;
const ANNOUNCE_RADIUS: number = 3 * 8;

// tile-corner-space even-odd ray cast; tiles are tested at their center (x+0.5, z+0.5)
// so points never land exactly on polygon edges
function polygonContains(px: number, pz: number): boolean {
    let inside: boolean = false;
    for (let i = 0, j = KOTH_POLYGON.length - 1; i < KOTH_POLYGON.length; j = i++) {
        const [xi, zi] = KOTH_POLYGON[i];
        const [xj, zj] = KOTH_POLYGON[j];
        if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

class Koth {
    currentHolder: string | null = null;
    holderSince: number = 0;
    private nextCaptureMs: number = 0;

    inZone(player: Player): boolean {
        return player.level === KOTH_LEVEL && polygonContains(player.x + 0.5, player.z + 0.5);
    }

    private eligible(player: Player): boolean {
        return this.inZone(player) && player.staffModLevel <= 1 && player.visibility === Visibility.DEFAULT;
    }

    // snapshot the winner's visual appearance as 12 resolved protocol slots
    // (0 = empty, 0x100+idk = identity kit, 0x200+obj = worn item), mirroring
    // Player.generateAppearance — resolution must happen here because wearpos2/3
    // masking and idk fallback need engine config the web/viewer layers don't have
    private buildLoadout(player: Player): string {
        const worn = player.getInventory(InvType.WORN);

        const skipped: number[] = [];
        if (worn) {
            for (let i = 0; i < worn.capacity; i++) {
                const equip = worn.get(i);
                if (!equip) {
                    continue;
                }
                const config = ObjType.get(equip.id);
                if (config.wearpos2 !== -1 && !skipped.includes(config.wearpos2)) {
                    skipped.push(config.wearpos2);
                }
                if (config.wearpos3 !== -1 && !skipped.includes(config.wearpos3)) {
                    skipped.push(config.wearpos3);
                }
            }
        }

        const slots: number[] = [];
        for (let slot = 0; slot < 12; slot++) {
            if (skipped.includes(slot)) {
                slots.push(0);
                continue;
            }
            const equip = worn ? worn.get(slot) : null;
            if (equip) {
                slots.push(0x200 + equip.id);
                continue;
            }
            const appearanceValue = player.getAppearanceInSlot(slot);
            slots.push(appearanceValue >= 1 ? appearanceValue : 0);
        }

        return JSON.stringify({
            gender: player.gender,
            colors: player.colors,
            slots
        });
    }

    // called every tick; awards at most one point per wall-clock minute (tick counting
    // would drift: dev runs 400ms ticks, prod 300ms, and overload shortens catch-up ticks)
    cycle(players: IterableIterator<Player>): KothCaptureEvent | null {
        const now: number = Date.now();
        if (now < this.nextCaptureMs) {
            return null;
        }
        this.nextCaptureMs = now + CAPTURE_INTERVAL_MS;

        const contenders: Player[] = [];
        const nearby: Player[] = [];
        for (const player of players) {
            if (player.level === KOTH_LEVEL && Math.max(Math.abs(player.x - ANNOUNCE_CENTER_X), Math.abs(player.z - ANNOUNCE_CENTER_Z)) <= ANNOUNCE_RADIUS) {
                nearby.push(player);
            }
            if (this.eligible(player)) {
                contenders.push(player);
            }
        }
        if (contenders.length === 0) {
            // an empty hill has no king: nobody scores, and the previous holder also
            // loses the tie-break advantage until they retake it
            this.currentHolder = null;
            return null;
        }

        let maxCombat: number = 0;
        for (const player of contenders) {
            if (player.combatLevel > maxCombat) {
                maxCombat = player.combatLevel;
            }
        }
        const tied: Player[] = contenders.filter(p => p.combatLevel === maxCombat);

        let winner: Player | undefined = tied.find(p => p.username === this.currentHolder);
        if (!winner) {
            winner = tied[Math.floor(Math.random() * tied.length)];
        }

        if (winner.username !== this.currentHolder) {
            this.currentHolder = winner.username;
            this.holderSince = now;
            for (const player of nearby) {
                player.messageGame(`${winner.displayName} now controls the ruins.`);
            }
        }

        return {
            timestamp: now,
            profile: Environment.node.profile,
            username: winner.username,
            combat_level: winner.combatLevel,
            contenders: contenders.length,
            loadout: this.buildLoadout(winner)
        };
    }
}

export default new Koth();
