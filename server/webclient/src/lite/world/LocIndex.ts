// Static world loc index for the lite client.
//
// The browser client learns where locs are by decoding map files into a 3D scene
// as it walks (OnDemand -> ClientBuild.loadLocations -> World.addScenery/setWall/...).
// StateCollector then reads them back out with world.sceneType/wallType/decorType.
//
// Headless we skip the scene entirely and precompute the whole world once from
// /ondemand.zip, which the engine already serves (a snapshot of cache idx1-4).
// The result is four sorted key/value arrays - about 8 bytes per loc - shared by
// every bot in the process and cached on disk so it's built once per machine.
//
// Placement note: ClientBuild.loadLocations computes a `currentLevel` for the
// LinkBelow bridge adjustment but passes the RAW file `level` to addLoc - the
// adjustment only picks a collision map. So scene placement needs no land data
// at all, which is why this index reads loc files only.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { gunzipSync, unzipSync } from 'fflate';

import JagFile from '#/io/JagFile.js';
import Packet from '#/io/Packet.js';
import { LocLayer } from '#/dash3d/LocLayer.js';
import { LOC_SHAPE_TO_LAYER } from '#/dash3d/LocShape.js';

/** Layers, in the order World stores them. Index matches LocLayer. */
export const LAYER_COUNT = 4;

const INDEX_FORMAT_VERSION = 2;
const MAGIC = 0x4c4f4331; // 'LOC1'

/**
 * Serialised sections: the four loc layers plus one for terrain map flags
 * (MapFlag.Block / LinkBelow), which the collision builder needs to block
 * water and cliffs the same way ClientBuild.finishBuild does.
 */
const SECTION_COUNT = LAYER_COUNT + 1;
const FLAGS_SECTION = LAYER_COUNT;

/** key = level<<28 | x<<14 | z  (x,z < 16384, level < 4) */
function packKey(level: number, x: number, z: number): number {
    return ((level & 0x3) << 28) | ((x & 0x3fff) << 14) | (z & 0x3fff);
}

/** value = locId<<7 | shape<<2 | angle */
function packValue(locId: number, shape: number, angle: number): number {
    return (locId << 7) | ((shape & 0x1f) << 2) | (angle & 0x3);
}

export function valueLocId(value: number): number {
    return value >>> 7;
}

export function valueShape(value: number): number {
    return (value >>> 2) & 0x1f;
}

export function valueAngle(value: number): number {
    return value & 0x3;
}

interface LayerData {
    keys: Int32Array;
    values: Int32Array;
}

export class LocIndex {
    private constructor(private readonly layers: LayerData[]) {}

    get size(): number {
        return this.layers.reduce((n, l) => n + l.keys.length, 0);
    }

    /** Terrain flags (MapFlag bits) at a world coordinate, or 0. */
    mapFlags(level: number, worldX: number, worldZ: number): number {
        return this.lookupSection(FLAGS_SECTION, level, worldX, worldZ);
    }

    /**
     * Value at a world coordinate for one layer, or 0 if empty.
     * Returns the packed (locId, shape, angle) triple - see valueLocId etc.
     */
    lookup(layer: LocLayer, level: number, worldX: number, worldZ: number): number {
        return this.lookupSection(layer, level, worldX, worldZ);
    }

    private lookupSection(section: number, level: number, worldX: number, worldZ: number): number {
        const data = this.layers[section];
        if (!data) {
            return 0;
        }

        const key = packKey(level, worldX, worldZ);
        let lo = 0;
        let hi = data.keys.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const probe = data.keys[mid];
            if (probe === key) {
                return data.values[mid];
            }
            if (probe < key) {
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return 0;
    }

    // ---------------------------------------------------------------- building

    /**
     * Build from the server's /ondemand.zip + versionlist archive, using a disk
     * cache keyed by the versionlist CRC (which changes whenever maps repack).
     */
    static async load(opts: { origin: string; cacheDir: string; versionlistCrc: number; quiet?: boolean }): Promise<LocIndex> {
        const log = opts.quiet ? () => {} : (m: string) => console.log(`[lite:locs] ${m}`);
        const cachePath = `${opts.cacheDir}/locindex-${opts.versionlistCrc >>> 0}.bin`;

        const cached = await LocIndex.readCache(cachePath);
        if (cached) {
            log(`loaded ${cached.size} locs from cache`);
            return cached;
        }

        log('building world loc index (first run only)...');
        const t0 = performance.now();

        const versionlist = new JagFile(await httpGet(`${opts.origin}/versionlist${opts.versionlistCrc}`));
        const mapIndexData = versionlist.read('map_index');
        if (!mapIndexData) {
            throw new Error('lite: versionlist has no map_index');
        }

        const zip = unzipSync(await httpGet(`${opts.origin}/ondemand.zip`));

        const buf = new Packet(mapIndexData);
        const squares = mapIndexData.length / 7;

        const keysBySection: number[][] = [[], [], [], [], []];
        const valuesBySection: number[][] = [[], [], [], [], []];

        let missingLoc = 0;
        let missingLand = 0;
        for (let i = 0; i < squares; i++) {
            const mapsquare = buf.g2();
            const landFile = buf.g2();
            const locFile = buf.g2();
            buf.g1(); // members-only flag

            const baseX = (mapsquare >> 8) * 64;
            const baseZ = (mapsquare & 0xff) * 64;

            const locEntry = zip[`4.${locFile}`];
            if (locEntry) {
                decodeLocFile(gunzipSync(locEntry), baseX, baseZ, keysBySection, valuesBySection);
            } else {
                missingLoc++;
            }

            const landEntry = zip[`4.${landFile}`];
            if (landEntry) {
                decodeLandFile(gunzipSync(landEntry), baseX, baseZ, keysBySection[FLAGS_SECTION], valuesBySection[FLAGS_SECTION]);
            } else {
                missingLand++;
            }
        }

        if (missingLoc > 0 || missingLand > 0) {
            log(`warning: ${missingLoc} loc / ${missingLand} land files absent from ondemand.zip`);
        }

        const layers: LayerData[] = [];
        for (let section = 0; section < SECTION_COUNT; section++) {
            layers[section] = sortLayer(keysBySection[section], valuesBySection[section]);
        }

        const index = new LocIndex(layers);
        log(`built ${index.size} entries from ${squares} mapsquares in ${(performance.now() - t0).toFixed(0)}ms`);

        await LocIndex.writeCache(cachePath, layers);
        return index;
    }

    private static async readCache(path: string): Promise<LocIndex | null> {
        const file = Bun.file(path);
        if (!(await file.exists())) {
            return null;
        }

        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== INDEX_FORMAT_VERSION) {
                return null;
            }

            const layers: LayerData[] = [];
            let offset = 8;
            for (let section = 0; section < SECTION_COUNT; section++) {
                const count = view.getUint32(offset, true);
                offset += 4;
                // Copy rather than subarray-view: the source buffer isn't guaranteed
                // to be 4-byte aligned for Int32Array.
                const keys = new Int32Array(count);
                const values = new Int32Array(count);
                for (let i = 0; i < count; i++) {
                    keys[i] = view.getInt32(offset + i * 4, true);
                }
                offset += count * 4;
                for (let i = 0; i < count; i++) {
                    values[i] = view.getInt32(offset + i * 4, true);
                }
                offset += count * 4;
                layers[section] = { keys, values };
            }
            return new LocIndex(layers);
        } catch {
            return null;
        }
    }

    private static async writeCache(path: string, layers: LayerData[]): Promise<void> {
        let size = 8;
        for (const l of layers) {
            size += 4 + l.keys.length * 8;
        }

        const bytes = new Uint8Array(size);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, MAGIC, true);
        view.setUint32(4, INDEX_FORMAT_VERSION, true);

        let offset = 8;
        for (const l of layers) {
            view.setUint32(offset, l.keys.length, true);
            offset += 4;
            for (let i = 0; i < l.keys.length; i++) {
                view.setInt32(offset + i * 4, l.keys[i], true);
            }
            offset += l.keys.length * 4;
            for (let i = 0; i < l.values.length; i++) {
                view.setInt32(offset + i * 4, l.values[i], true);
            }
            offset += l.values.length * 4;
        }

        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, bytes);
    }
}

/**
 * Port of ClientBuild.loadLocations' stream format, minus the scene building.
 * Two nested delta-coded loops: loc ids, then packed coords per loc id.
 */
function decodeLocFile(src: Uint8Array, baseX: number, baseZ: number, keysByLayer: number[][], valuesByLayer: number[][]): void {
    const buf = new Packet(src);
    let locId = -1;

    while (true) {
        const deltaId = buf.gsmart();
        if (deltaId === 0) {
            return;
        }
        locId += deltaId;

        let locPos = 0;
        while (true) {
            const deltaPos = buf.gsmart();
            if (deltaPos === 0) {
                break;
            }

            locPos += deltaPos - 1;
            const z = locPos & 0x3f;
            const x = (locPos >> 6) & 0x3f;
            const level = locPos >> 12;

            const info = buf.g1();
            const shape = info >> 2;
            const angle = info & 0x3;

            const layer = LOC_SHAPE_TO_LAYER[shape] ?? LocLayer.GROUND;
            keysByLayer[layer].push(packKey(level, baseX + x, baseZ + z));
            valuesByLayer[layer].push(packValue(locId, shape, angle));
        }
    }
}

/**
 * Port of the mapl half of ClientBuild.loadGround. We only keep the per-tile
 * flag byte (opcodes 50..81); heights, floor types and overlays are rendering
 * concerns. MapFlag.Block feeds collision, MapFlag.LinkBelow the bridge
 * adjustment - see CollisionBuilder.
 */
function decodeLandFile(src: Uint8Array, baseX: number, baseZ: number, keys: number[], values: number[]): void {
    const buf = new Packet(src);

    for (let level = 0; level < 4; level++) {
        for (let x = 0; x < 64; x++) {
            for (let z = 0; z < 64; z++) {
                while (true) {
                    const opcode = buf.g1();
                    if (opcode === 0) {
                        break;
                    }
                    if (opcode === 1) {
                        buf.g1(); // height
                        break;
                    }
                    if (opcode <= 49) {
                        buf.g1(); // overlay type
                    } else if (opcode <= 81) {
                        const flags = ((opcode - 49) << 24) >> 24;
                        if (flags !== 0) {
                            keys.push(packKey(level, baseX + x, baseZ + z));
                            values.push(flags & 0xff);
                        }
                    }
                    // opcode > 81 sets the underlay floor type - no extra bytes
                }
            }
        }
    }
}

function sortLayer(keys: number[], values: number[]): LayerData {
    // Sort an index permutation so keys and values stay paired, breaking ties by
    // original position. Two locs of the same layer can share a tile (stacked
    // walls); World.setWall/addScenery overwrite, so last-in-file wins and we
    // drop the earlier ones - otherwise binary search would return an arbitrary
    // member of the duplicate run.
    const order: number[] = new Array(keys.length);
    for (let i = 0; i < order.length; i++) {
        order[i] = i;
    }
    order.sort((a, b) => keys[a] - keys[b] || a - b);

    const outKeys = new Int32Array(keys.length);
    const outValues = new Int32Array(values.length);
    let n = 0;
    for (let i = 0; i < order.length; i++) {
        const key = keys[order[i]];
        if (n > 0 && outKeys[n - 1] === key) {
            outValues[n - 1] = values[order[i]];
            continue;
        }
        outKeys[n] = key;
        outValues[n] = values[order[i]];
        n++;
    }

    return { keys: outKeys.slice(0, n), values: outValues.slice(0, n) };
}

async function httpGet(url: string): Promise<Uint8Array> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`lite: GET ${url} failed with ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
}
